import { jobInput, progressInput } from "./jobs.mjs";
import { validateDraft, reviewDraft, validId } from "./review.mjs";
import * as auth from "./auth.mjs";
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const failure = (code, status) => json({ error: code }, status);
function secure(r) {
  const h = new Headers(r.headers);
  h.set("Cache-Control", "no-store");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Frame-Options", "DENY");
  h.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
  );
  return new Response(r.body, { status: r.status, headers: h });
}
async function readJSON(r, max = 16384) {
  const declared = Number(r.headers.get("Content-Length") || 0);
  if (declared > max) throw new Error("request_too_large");
  let size = 0,
    parts = [];
  const reader = r.body?.getReader();
  if (!reader) throw new Error("invalid_request");
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error("request_too_large");
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function machine(r, e) {
  const value = r.headers.get("Authorization");
  if (!e.BATCH_TOKEN || !value?.startsWith("Bearer ")) return false;
  return (await auth.hash(value.slice(7))) === (await auth.hash(e.BATCH_TOKEN));
}
async function internal(r, e, p) {
  if (!(await machine(r, e))) return failure("unauthorized", 401);
  if (p === "/internal/claim" && r.method === "POST") {
    const lease = auth.random();
    const row = await e.DB.prepare(
      "UPDATE jobs SET status='running',lease=? WHERE id=(SELECT id FROM jobs WHERE status='pending' ORDER BY created LIMIT 1) AND status='pending' RETURNING id,body",
    )
      .bind(await auth.hash(lease))
      .first();
    return json(row ? { id: row.id, ...JSON.parse(row.body), lease } : null);
  }
  const b = await readJSON(r, 12 * 1024 * 1024);
  if (!validId(b.jobId) || typeof b.lease !== "string")
    return failure("invalid_job", 400);
  const job = await e.DB.prepare(
    "SELECT * FROM jobs WHERE id=? AND lease=? AND status='running'",
  )
    .bind(b.jobId, await auth.hash(b.lease))
    .first();
  if (!job) return failure("job_conflict", 409);
  if (p === "/internal/source" && r.method === "POST") {
    const used = await e.DB.prepare("SELECT id FROM photos").all();
    return json({
      accessToken: await auth.microsoftToken(e),
      knownPhotoIds: used.results.map((x) => x.id),
      ...JSON.parse(job.body),
    });
  }
  if (p === "/internal/checkpoint" && r.method === "POST") {
    const previous=JSON.parse(job.body), progress=progressInput(b.progress,previous.progress);
    if(progress.batches !== (previous.progress?.batches||0)) throw new Error("invalid_progress");
    const updated=await e.DB.prepare("UPDATE jobs SET body=json_set(body,'$.progress',json(?)),status=CASE WHEN json_extract(body,'$.stopRequested')=1 THEN 'cancelled' ELSE 'pending' END,lease=NULL WHERE id=? AND lease=? AND status='running'")
      .bind(JSON.stringify(progress),job.id,job.lease).run();
    if(updated.meta.changes!==1) return failure("job_conflict",409);
    return json({ok:true});
  }
  if (p === "/internal/fail" && r.method === "POST") {
    await e.DB.prepare(
      "UPDATE jobs SET status='failed',lease=NULL WHERE id=? AND status='running'",
    )
      .bind(job.id)
      .run();
    return json({ ok: true });
  }
  if (p === "/internal/complete" && r.method === "POST") {
    if (
      !Array.isArray(b.drafts) ||
      b.drafts.length > 30 ||
      !Array.isArray(b.photos) ||
      b.photos.length > 300
    )
      throw new Error("invalid_batch");
    const previous=JSON.parse(job.body);
    if(previous.pipeline!==2 || !validId(b.batchId) || typeof b.more!=="boolean") throw new Error("invalid_batch");
    const progress=progressInput(b.progress,previous.progress);
    if(progress.batches!==(previous.progress?.batches||0)+1 || progress.processed-(previous.progress?.processed||0)>previous.maxPhotos || b.more!==(progress.processed<progress.total)) throw new Error("invalid_progress");
    if(progress.phase!==(b.more?"processing":"complete")) throw new Error("invalid_progress");
    const drafts = b.drafts.map(validateDraft),
      seen = new Set();
    if (new Set(drafts.map((d) => d.id)).size !== drafts.length)
      throw new Error("duplicate_draft");
    const photos = new Map(b.photos.map((p) => [p.id, p]));
    const stmts = [];
    for (const d of drafts) {
      if(!d.id.startsWith(`${job.id}-${b.batchId}-`)) throw new Error("invalid_batch");
      const existing = await e.DB.prepare("SELECT id FROM drafts WHERE id=?")
        .bind(d.id)
        .first();
      if (existing) throw new Error("duplicate_draft");
      for (const p of d.photos) {
        if (seen.has(p.id)) throw new Error("duplicate_photo");
        seen.add(p.id);
        const photo = photos.get(p.id);
        if (
          !photo ||
          photo.safety !== "allow" ||
          !Array.isArray(photo.flags) ||
          photo.flags.length ||
          typeof photo.jpeg !== "string" ||
          photo.jpeg.length > 300000
        )
          throw new Error("unsafe_photo");
        // Only JPEG previews from the bounded scanner enter private storage.
        const raw = Uint8Array.from(atob(photo.jpeg), (c) => c.charCodeAt(0));
        if (raw[0] !== 255 || raw[1] !== 216 || raw[2] !== 255)
          throw new Error("invalid_image");
        const used = await e.DB.prepare("SELECT id FROM photos WHERE id=?")
          .bind(p.id)
          .first();
        if (used) throw new Error("photo_already_used");
        stmts.push(
          e.DB.prepare("INSERT INTO photos(id,data,mime) VALUES(?,?,?)").bind(
            p.id,
            raw.buffer,
            "image/jpeg",
          ),
        );
      }
      stmts.push(
        e.DB.prepare("INSERT INTO drafts(id,body,version) VALUES(?,?,1)").bind(
          d.id,
          JSON.stringify(d),
        ),
      );
    }
    stmts.push(
      e.DB.prepare(
        "UPDATE jobs SET body=json_set(body,'$.progress',json(?),'$.lastBatch',?),status=CASE WHEN json_extract(body,'$.stopRequested')=1 THEN 'cancelled' ELSE ? END,lease=NULL WHERE id=? AND lease=? AND status='running'",
      ).bind(JSON.stringify(progress),b.batchId,b.more?'pending':'complete',job.id,job.lease),
    );
    await e.DB.batch(stmts);
    return json({ ok: true, count: drafts.length });
  }
  return failure("not_found", 404);
}
async function route(r, e) {
  const u = new URL(r.url),
    p = u.pathname;
  if (p === "/api/session") {
    const s = await auth.session(r, e);
    return json({
      user: s ? { login: s.login } : null,
      githubConfigured: auth.configured(e),
      microsoftConfigured: auth.msConfigured(e),
      onedriveConnected: s ? Boolean(await auth.get(e, "microsoft")) : false,
      publishingEnabled: false,
    });
  }
  if (p === "/auth/github/start" && r.method === "GET")
    return auth.githubStart(r, e);
  if (p === "/auth/github/callback" && r.method === "GET")
    return auth.githubFinish(r, e);
  if (p.startsWith("/internal/")) return internal(r, e, p);
  if (p.startsWith("/api/") || p.startsWith("/auth/")) {
    const user = await auth.session(r, e);
    if (!user) return failure("unauthorized", 401);
    if (
      !["GET", "HEAD"].includes(r.method) &&
      r.headers.get("Origin") !== u.origin
    )
      return failure("invalid_origin", 403);
    if (p === "/auth/logout" && r.method === "POST") {
      await auth.remove(
        e,
        "session:" + (await auth.hash(auth.cookies(r)[auth.cookieName])),
      );
      return new Response("{}", {
        headers: {
          "Set-Cookie": auth.cookie(auth.cookieName, "", 0),
          "Content-Type": "application/json",
        },
      });
    }
    if (p === "/auth/microsoft/start" && r.method === "GET")
      return auth.microsoftStart(r, e, user);
    if (p === "/auth/microsoft/callback" && r.method === "GET")
      return auth.microsoftFinish(r, e, user);
    if (p === "/api/drafts" && r.method === "GET") {
      const rows = await e.DB.prepare(
        "SELECT body FROM drafts ORDER BY id",
      ).all();
      return json(rows.results.map((x) => JSON.parse(x.body)));
    }
    if (p === "/api/jobs" && r.method === "GET") {
      const rows = await e.DB.prepare(
        "SELECT id,status,created,body FROM jobs ORDER BY created DESC LIMIT 10",
      ).all();
      return json(rows.results.map(({body,...row})=>{
        const v=JSON.parse(body);
        return {...row,folder:v.folder,selection:v.selection,maxPhotos:v.maxPhotos,locationHint:v.locationHint||"",progress:v.progress,stopRequested:Boolean(v.stopRequested)};
      }));
    }
    if (p.startsWith("/api/jobs/") && p.endsWith("/stop") && r.method==="POST") {
      const id=p.slice(10,-5);
      if(!validId(id)) return failure("not_found",404);
      const updated=await e.DB.prepare("UPDATE jobs SET body=json_set(body,'$.stopRequested',json('true')),status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END WHERE id=? AND status IN ('pending','running')").bind(id).run();
      return updated.meta.changes===1?json({ok:true}):failure("job_conflict",409);
    }
    if (p === "/api/jobs" && r.method === "POST") {
      if (!(await auth.get(e, "microsoft")))
        return failure("onedrive_not_connected", 409);
      const input = jobInput(await readJSON(r));
      const running = await e.DB.prepare(
        "SELECT id FROM jobs WHERE status IN ('pending','running') LIMIT 1",
      ).first();
      if (running) return failure("job_in_progress", 409);
      const id = crypto.randomUUID();
      await e.DB.prepare(
        "INSERT INTO jobs(id,body,status,created) VALUES(?,?,'pending',?)",
      )
        .bind(id, JSON.stringify(input), Date.now())
        .run();
      return json({ id, status: "pending" }, 201);
    }
    if (p.startsWith("/api/photos/") && r.method === "GET") {
      const id = p.slice(12);
      if (!validId(id)) return failure("not_found", 404);
      const row = await e.DB.prepare("SELECT data,mime FROM photos WHERE id=?")
        .bind(id)
        .first();
      return row
        ? new Response(new Uint8Array(row.data), {
            headers: { "Content-Type": row.mime },
          })
        : failure("not_found", 404);
    }
    if (p.startsWith("/api/drafts/") && r.method === "PATCH") {
      const id = p.slice(12);
      if (!validId(id)) return failure("not_found", 404);
      const row = await e.DB.prepare("SELECT body FROM drafts WHERE id=?")
        .bind(id)
        .first();
      if (!row) return failure("not_found", 404);
      const current = JSON.parse(row.body),
        next = reviewDraft(current, await readJSON(r));
      const updated = await e.DB.prepare(
        "UPDATE drafts SET body=?,version=? WHERE id=? AND version=?",
      )
        .bind(JSON.stringify(next), next.version, id, current.version)
        .run();
      if (updated.meta.changes !== 1) return failure("version_conflict", 409);
      return json(next);
    }
    return failure("not_found", 404);
  }
  return e.ASSETS.fetch(r);
}
export default {
  async fetch(r, e) {
    try {
      return secure(await route(r, e));
    } catch (err) {
      const known = new Set([
        "invalid_oauth_state",
        "github_not_allowed",
        "github_exchange_failed",
        "microsoft_exchange_failed",
        "invalid_dates",
        "invalid_range",
        "invalid_batch_size",
        "invalid_progress",
        "invalid_location_hint",
        "invalid_folder",
        "version_conflict",
        "save_before_approval",
        "request_too_large",
        "duplicate_draft",
        "photo_already_used",
        "unsafe_photo",
        "invalid_batch",
        "invalid_image",
        "onedrive_not_connected",
        "reauthorization_required",
      ]);
      const code = known.has(err.message) ? err.message : "request_failed";
      return secure(failure(code, code === "version_conflict" ? 409 : 400));
    }
  },
};
