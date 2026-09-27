// Private, immutable R2 snapshots. D1's inventory-current pointer advances in
// the same batch as the job checkpoint, never merely because an upload worked.
const MAX_BYTES = 24 * 1024 * 1024;
const refPattern = /^[0-9a-f-]{36}$/;
const digestPattern = /^[0-9a-f]{64}$/;

const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  x => x.toString(16).padStart(2, '0')).join('');
const hex = bytes => bytes ? Array.from(new Uint8Array(bytes),
  x => x.toString(16).padStart(2, '0')).join('') : null;
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
});

async function running(e, request) {
  const id = request.headers.get('X-Job-Id');
  const lease = request.headers.get('X-Job-Lease');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id || '') || !lease) throw new Error('invalid_job');
  const leaseHash = await digest(new TextEncoder().encode(lease));
  const row = await e.DB.prepare("SELECT id FROM jobs WHERE id=? AND lease=? AND status='running'")
    .bind(id, leaseHash).first();
  if (!row) throw new Error('job_conflict');
  return {id, leaseHash};
}

export async function inventoryRequest(request, e) {
  if (!e.MEDIA_BUCKET) return response({error: 'storage_unavailable'}, 503);
  if (request.method === 'GET') {
    await running(e, request);
    const current = await e.DB.prepare("SELECT value FROM state WHERE key='inventory-current'").first();
    if (!current) return new Response(null, {status: 204});
    const info = JSON.parse(current.value);
    const object = await e.MEDIA_BUCKET.get(info.key);
    if (!object?.body || object.size !== info.bytes || info.bytes > MAX_BYTES ||
        hex(object.checksums?.sha256) !== info.digest) throw new Error('inventory_unavailable');
    return new Response(object.body, {headers: {'Content-Type': 'application/zip',
      'X-Inventory-Sha256': info.digest, 'Cache-Control': 'no-store'}});
  }
  if (request.method !== 'PUT') return response({error: 'not_found'}, 404);
  const seed = request.headers.get('X-Inventory-Seed') === '1';
  const job = seed ? null : await running(e, request);
  if (seed) {
    const current = await e.DB.prepare("SELECT 1 FROM state WHERE key='inventory-current'").first();
    const active = await e.DB.prepare("SELECT 1 FROM jobs WHERE status='running' LIMIT 1").first();
    if (current || active) return response({error: 'inventory_conflict'}, 409);
  }
  const expected = request.headers.get('X-Inventory-Sha256');
  if (!digestPattern.test(expected || '') || request.headers.get('Content-Type') !== 'application/zip')
    throw new Error('invalid_inventory');
  const length = Number(request.headers.get('Content-Length'));
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_BYTES || !request.body)
    throw new Error('inventory_too_large');
  const ref = crypto.randomUUID();
  const info = {key: 'inventories/' + ref, digest: expected, bytes: length};
  const stored = await e.MEDIA_BUCKET.put(info.key, request.body, {sha256: expected,
    httpMetadata: {contentType: 'application/zip'}});
  if (!stored || stored.size !== length || hex(stored.checksums?.sha256) !== expected)
    throw new Error('storage_unavailable');
  if (seed) {
    const result = await e.DB.prepare("INSERT OR IGNORE INTO state(key,value,expires) VALUES('inventory-current',?,NULL)")
      .bind(JSON.stringify(info)).run();
    if (result.meta.changes !== 1) throw new Error('inventory_conflict');
  } else {
    await e.DB.prepare('INSERT INTO state(key,value,expires) VALUES(?,?,?)')
      .bind('inventory-stage:' + ref, JSON.stringify({...info, jobId: job.id, leaseHash: job.leaseHash}),
        Date.now() + 86400000).run();
  }
  return response({ref});
}

export async function inventoryStatus(e) {
  if (!e.MEDIA_BUCKET) return response({error: 'storage_unavailable'}, 503);
  const current = await e.DB.prepare("SELECT value FROM state WHERE key='inventory-current'").first();
  if (!current) return response({ready: false});
  const info = JSON.parse(current.value);
  const object = await e.MEDIA_BUCKET.head(info.key);
  if (!object || object.size !== info.bytes || hex(object.checksums?.sha256) !== info.digest)
    return response({error: 'inventory_unavailable'}, 503);
  return response({ready: true, bytes: info.bytes});
}

export async function inventoryCommit(e, job, body) {
  const current = await e.DB.prepare("SELECT 1 FROM state WHERE key='inventory-current'").first();
  if (!body.inventoryRef) {
    if (current) throw new Error('inventory_required');
    return null; // Existing VPS processor stays usable until the one-time seed.
  }
  if (!refPattern.test(body.inventoryRef)) throw new Error('invalid_inventory');
  const stage = await e.DB.prepare('SELECT value,expires FROM state WHERE key=?')
    .bind('inventory-stage:' + body.inventoryRef).first();
  if (!stage || stage.expires <= Date.now()) throw new Error('inventory_unavailable');
  const info = JSON.parse(stage.value);
  if (info.jobId !== job.id || info.leaseHash !== job.lease || !digestPattern.test(info.digest))
    throw new Error('inventory_conflict');
  const value = JSON.stringify({key: info.key, digest: info.digest, bytes: info.bytes});
  return e.DB.prepare("INSERT INTO state(key,value,expires) SELECT 'inventory-current',?,NULL WHERE EXISTS(SELECT 1 FROM jobs WHERE id=? AND lease=? AND status='running') ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=NULL")
    .bind(value, job.id, job.lease);
}

export async function cleanupInventories(e, now = Date.now()) {
  if (!e.MEDIA_BUCKET?.list) return;
  const row = await e.DB.prepare("SELECT value FROM state WHERE key='inventory-current'").first();
  const current = row ? JSON.parse(row.value).key : null;
  let cursor;
  let removed = 0;
  for (let page = 0; page < 3 && removed < 20; page++) {
    const listing = await e.MEDIA_BUCKET.list({prefix: 'inventories/', limit: 1000, ...(cursor ? {cursor} : {})});
    for (const object of listing.objects || []) {
      if (removed >= 20) break;
      const uploaded = new Date(object.uploaded).getTime();
      if (object.key === current || !object.key.startsWith('inventories/') ||
          !Number.isFinite(uploaded) || uploaded > now - 7 * 86400000) continue;
      const ref = object.key.slice('inventories/'.length);
      if (!refPattern.test(ref)) continue;
      const stage = await e.DB.prepare('SELECT expires FROM state WHERE key=?')
        .bind('inventory-stage:' + ref).first();
      if (stage && stage.expires > now) continue;
      await e.MEDIA_BUCKET.delete(object.key);
      await e.DB.prepare('DELETE FROM state WHERE key=?').bind('inventory-stage:' + ref).run();
      removed++;
    }
    if (!listing.truncated || !listing.cursor) break;
    cursor = listing.cursor;
  }
}
