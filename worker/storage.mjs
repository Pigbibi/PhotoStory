const DAY=86400000;
const fail=code=>{throw new Error(code);};
export const usesR2=e=>Boolean(e.MEDIA_BUCKET)||e.MEDIA_STORAGE==='r2';
const digest=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),x=>x.toString(16).padStart(2,'0')).join('');
function limits(e){
 const bounded=(key,fallback,max)=>{
  const v=Number(e[key]??fallback);
  if(!Number.isSafeInteger(v)||v<1||v>max)fail('storage_unavailable');return v;
 };
 return {limitBytes:bounded('STORAGE_MAX_BYTES',8000000000,8000000000),writeLimit:bounded('STORAGE_WRITE_LIMIT',100000,1000000),readLimit:bounded('STORAGE_READ_LIMIT',1000000,10000000)};
}
const month=()=>new Date().toISOString().slice(0,7);
async function operation(e,kind){
 if(!e.MEDIA_BUCKET)fail('storage_unavailable');
 const limit=limits(e)[kind==='reads'?'readLimit':'writeLimit'];
 const result=await e.DB.prepare(`INSERT INTO storage_operations VALUES(?,?,?) ON CONFLICT(month) DO UPDATE SET ${kind}=${kind}+1 WHERE ${kind}<?`)
  .bind(month(),kind==='reads'?1:0,kind==='writes'?1:0,limit).run();
 if(result.meta.changes!==1)fail('storage_request_limit');
}
export async function storageView(e){
 if(!usesR2(e))return {backend:'d1'};
 const totals=await e.DB.prepare('SELECT bytes,objects FROM storage_totals WHERE id=1').first();
 const ops=await e.DB.prepare('SELECT reads,writes FROM storage_operations WHERE month=?').bind(month()).first();
 const pending=await e.DB.prepare('SELECT count(*) AS n FROM photos WHERE length(data)>0').first();
 const l=limits(e),usedBytes=totals?.bytes??0;
 return {backend:'r2',available:Boolean(e.MEDIA_BUCKET),...l,usedBytes,objects:totals?.objects??0,
  reads:ops?.reads??0,writes:ops?.writes??0,month:month(),legacyPreviews:pending.n,
  warning:usedBytes>=l.limitBytes*.8||(ops?.reads??0)>=l.readLimit*.8||(ops?.writes??0)>=l.writeLimit*.8,
  full:usedBytes>=l.limitBytes||(ops?.writes??0)>=l.writeLimit||(ops?.reads??0)>=l.readLimit};
}
export async function storeImage(e,ref,input){
 const data=new Uint8Array(input);
 if(!usesR2(e))return data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);
 if(!/^(preview:[A-Za-z0-9_-]{1,128}|publication:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128})$/.test(ref)||!data.length||data.length>1800000)fail('invalid_image');
 const checksum=await digest(data),now=Date.now();
 const existing=await e.DB.prepare('SELECT * FROM image_objects WHERE ref=?').bind(ref).first();
 if(existing){
  if(existing.digest!==checksum)fail('storage_conflict');
  if(existing.state!=='ready')fail('storage_busy');
  const refreshed=await e.DB.prepare("UPDATE image_objects SET touched=? WHERE ref=? AND state='ready'").bind(now,ref).run();
  if(refreshed.meta.changes!==1)fail('storage_busy');
  return new ArrayBuffer(0);
 }
 const key='images/'+crypto.randomUUID();
 const reserved=await e.DB.prepare("INSERT INTO image_objects SELECT ?,?,?,?,'writing',? WHERE (SELECT bytes FROM storage_totals WHERE id=1)+?<=? ON CONFLICT DO NOTHING RETURNING ref")
  .bind(ref,key,data.length,checksum,now,data.length,limits(e).limitBytes).first();
 if(!reserved)fail('storage_limit');
 // An uncertain PUT retains its reservation. Never free capacity or overwrite
 // its key on a retry; an operator must reconcile the ambiguous upload.
 try{await operation(e,'writes');}catch(err){
  // No R2 request was sent, so this reservation can safely be released.
  await e.DB.prepare("DELETE FROM image_objects WHERE ref=? AND object_key=? AND state='writing'").bind(ref,key).run();
  throw err;
 }
 try{
  const result=await e.MEDIA_BUCKET.put(key,data,{httpMetadata:{contentType:'image/jpeg'},sha256:checksum,storageClass:'Standard'});
  if(!result||result.size!==data.length)fail('storage_unavailable');
 }catch{fail('storage_unavailable');}
 const saved=await e.DB.prepare("UPDATE image_objects SET state='ready' WHERE ref=? AND object_key=? AND state='writing'").bind(ref,key).run();
 if(saved.meta.changes!==1)fail('storage_busy');
 return new ArrayBuffer(0);
}
export async function readImage(e,ref,legacy){
 let data=new Uint8Array(legacy);
 if(!data.length){
  const entry=await e.DB.prepare("SELECT * FROM image_objects WHERE ref=? AND state='ready'").bind(ref).first();
  if(!entry)fail('storage_unavailable');
  await operation(e,'reads');
  let object;
  try{object=await e.MEDIA_BUCKET.get(entry.object_key);}catch{fail('storage_unavailable');}
  if(!object||object.size!==entry.bytes)fail('storage_unavailable');
  data=new Uint8Array(await object.arrayBuffer());
  if(data.length!==entry.bytes||await digest(data)!==entry.digest)fail('storage_unavailable');
 }
 return new Response(data,{headers:{'Content-Type':'image/jpeg','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow'}});
}
export async function migrateImages(e){
 if(!usesR2(e)||!e.MEDIA_BUCKET)fail('storage_unavailable');
 let migrated=0;
 // Bounded, repeatable copies. Existing bytes are removed only after GET/hash
 // verification, and a concurrent change cannot be cleared by this migration.
 const photos=(await e.DB.prepare('SELECT id,data FROM photos WHERE length(data)>0 LIMIT 10').all()).results;
 for(const p of photos){
  const bytes=new Uint8Array(p.data),ref='preview:'+p.id;
  await storeImage(e,ref,bytes);
  await readImage(e,ref,new Uint8Array());
  const result=await e.DB.prepare("UPDATE photos SET data=X'' WHERE id=? AND data=?").bind(p.id,bytes.buffer).run();
  migrated+=result.meta.changes;
 }
 const images=(await e.DB.prepare("SELECT i.* FROM publication_images i JOIN publications p ON p.id=i.publication_id WHERE length(i.data)>0 AND p.expires>? LIMIT 8").bind(Date.now()).all()).results;
 for(const p of images){
  const bytes=new Uint8Array(p.data),ref='publication:'+p.publication_id+':'+p.photo_id;
  await storeImage(e,ref,bytes);await readImage(e,ref,new Uint8Array());
  const result=await e.DB.prepare("UPDATE publication_images SET data=X'' WHERE publication_id=? AND photo_id=? AND data=?").bind(p.publication_id,p.photo_id,bytes.buffer).run();
  migrated+=result.meta.changes;
 }
 return {migrated,storage:await storageView(e)};
}
export async function cleanupImages(e,now=Date.now()){
 if(!usesR2(e)||!e.MEDIA_BUCKET)return;
 // Avoid scanning a long-lived image catalog every minute on the VPS timer.
 const slot=await e.DB.prepare("INSERT INTO state VALUES('r2-cleanup-next',?,NULL) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(state.value AS INTEGER)<=? RETURNING key")
  .bind(String(now+3600000),now).first();
 if(!slot)return;
 // Keep referenced drafts forever. A grace period protects uploads awaiting
 // their D1 transaction. Expired delivery files can be removed immediately.
 const condition=`(state='deleting' OR state='ready' AND (
  (ref LIKE 'preview:%' AND touched<=? AND NOT EXISTS(SELECT 1 FROM photos WHERE image_objects.ref='preview:'||photos.id) AND NOT EXISTS(SELECT 1 FROM drafts,json_each(drafts.body,'$.photos') p WHERE image_objects.ref='preview:'||json_extract(p.value,'$.id'))) OR
  (ref LIKE 'publication:%' AND (
    EXISTS(SELECT 1 FROM publications p WHERE image_objects.ref LIKE 'publication:'||p.id||':%' AND p.expires<=?) OR
    (touched<=? AND NOT EXISTS(SELECT 1 FROM publication_images i WHERE image_objects.ref='publication:'||i.publication_id||':'||i.photo_id))
  ))))`;
 const entries=(await e.DB.prepare(`SELECT ref,object_key FROM image_objects WHERE ${condition} LIMIT 50`).bind(now-DAY,now,now-DAY).all()).results;
 for(const entry of entries){
  const claim=await e.DB.prepare(`UPDATE image_objects SET state='deleting' WHERE ref=? AND ${condition}`).bind(entry.ref,now-DAY,now,now-DAY).run();
  if(claim.meta.changes!==1)continue;
  try{await e.MEDIA_BUCKET.delete(entry.object_key);}catch{continue;}
  await e.DB.prepare("DELETE FROM image_objects WHERE ref=? AND object_key=? AND state='deleting'").bind(entry.ref,entry.object_key).run();
 }
}
