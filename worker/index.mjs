import * as history from './history.mjs';
import * as publishing from './publishing.mjs';
import {storeImage,readImage,migrateImages} from './storage.mjs';
import {automatic} from './automatic-publishing.mjs';
import {backfillTravel} from './travel.mjs';
import * as instagram from './instagram.mjs';
import {original,reviewedDraft,sourceRecord,recoverSource} from './originals.mjs';
import {strictApproval,ownerPreferenceCounters} from './auto-review.mjs';
import {jobLanguages} from './languages.mjs';
import { jobInput, progressInput } from "./jobs.mjs";
import {settingsView,saveSettings,maintenance,RETENTION} from './lifecycle.mjs';
import { validateDraft, reviewDraft, validId } from "./review.mjs";
import * as auth from "./auth.mjs";
import * as health from './health.mjs';
import {inventoryRequest,inventoryCommit,inventoryStatus} from './inventory-state.mjs';
import {json,failure,errorResponse} from './http.mjs';
import {failureCodeSet,failureStageSet} from './vocabulary.mjs';

const BODY_LIMIT={small:4096,history:128000,automatic:2600000,batch:12*1024*1024};
const PREFIX={publish:'/api/publish/',photos:'/api/photos/',drafts:'/api/drafts/',export:'/api/export/',jobs:'/api/jobs/',delivery:'/delivery/'};

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

// One reader for every request body. A caller that needs bytes and a caller that
// needs JSON must not each re-implement the bounded accumulation loop.
async function readBytes(r, max, tooLarge="request_too_large", noBody="invalid_request") {
  const declared = Number(r.headers.get("Content-Length") || 0);
  if (declared > max) throw new Error(tooLarge);
  const reader = r.body?.getReader();
  if (!reader) throw new Error(noBody);
  let size = 0, parts = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error(tooLarge);
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.length;
  }
  return bytes;
}
async function readJSON(r, max = 16384) {
  return JSON.parse(new TextDecoder().decode(await readBytes(r, max)));
}

async function machine(r, e) {
  const value = r.headers.get("Authorization");
  if (!e.BATCH_TOKEN || !value?.startsWith("Bearer ")) return false;
  return (await auth.hash(value.slice(7))) === (await auth.hash(e.BATCH_TOKEN));
}

const jobFailureCode = (value) => (typeof value === "string" && failureCodeSet.has(value) ? value : "unknown");
const jobFailureStage = (value) => (typeof value === "string" && failureStageSet.has(value) ? value : null);

async function photoSources(r, e) {
  if (r.method === "GET")
    return json((await e.DB.prepare("SELECT id FROM photos WHERE NOT EXISTS(SELECT 1 FROM state WHERE key='photo-source:'||photos.id) LIMIT 100").all()).results);
  const b = await readJSON(r);
  if (!Array.isArray(b.sources) || b.sources.length > 10 || (b.dryRun !== undefined && typeof b.dryRun !== 'boolean')) throw new Error('invalid_request');
  const statements = [];
  for (const p of b.sources) {
    if (!validId(p.id) || !await e.DB.prepare('SELECT id FROM photos WHERE id=?').bind(p.id).first()) throw new Error('source_unavailable');
    const source = await recoverSource(e, p.id, p.item, p.fingerprint, p.policy);
    statements.push(e.DB.prepare("INSERT OR IGNORE INTO state(key,value,expires) VALUES(?,?,NULL)").bind('photo-source:' + p.id, JSON.stringify(source)));
  }
  if (statements.length && !b.dryRun) await e.DB.batch(statements);
  return json({ ok: true });
}

async function claim(e) {
  const view = await settingsView(e);
  if (view.backlogPaused || view.storage?.full) return json(null);
  const lease = auth.random();
  const row = await e.DB.prepare(
    "UPDATE jobs SET status='running',lease=? WHERE id=(SELECT id FROM jobs WHERE status='pending' ORDER BY created LIMIT 1) AND status='pending' RETURNING id,body",
  )
    .bind(await auth.hash(lease))
    .first();
  return json(row ? { id: row.id, ...JSON.parse(row.body), lease } : null);
}

async function source(e, job) {
  const used = await e.DB.prepare("SELECT id FROM photos").all();
  const prior = (await e.DB.prepare("SELECT id,body FROM drafts WHERE json_extract(body,'$.status') IN ('draft','approved') ORDER BY CASE json_extract(body,'$.status') WHEN 'approved' THEN 0 ELSE 1 END,rowid DESC LIMIT 50").all()).results;
  const view = await settingsView(e);
  return json({
    accessToken: await auth.microsoftToken(e),
    knownPhotoIds: [...new Set([...used.results.map((x) => x.id), ...await history.excluded(e)])],
    reviewMode: "manual",
    strictAutoEnabled: view.settings.reviewMode === "strict_auto",
    ownerPreferenceCounters: await auth.get(e, 'ownerPreferenceCounters') || { coherent: 0, compositionGood: 0, noDuplicateFrames: 0 },
    ownerCurationFeedback: await auth.get(e, 'ownerCurationFeedback') || { removedFromCarousel: 0 },
    ownerRejectionFeedback: await auth.get(e, 'ownerRejectionFeedback') || { categories: {}, recent: [] },
    captionLanguage: "en",
    editorLanguage: "zh-CN", // Legacy jobs keep their original prompt language.
    ...JSON.parse(job.body),
    referenceDrafts: prior.map(row => { const d = JSON.parse(row.body); return { id: row.id, status: d.status, title: d.title, caption: d.caption.slice(0, 400), photos: d.photos.slice(0, 2).map(p => ({ alt: p.alt })) }; }),
    draftLimit: Math.max(0, Math.min(8, view.settings.draftLimit, view.settings.pendingLimit - view.pending)),
  });
}

async function checkpoint(e, job, b) {
  const previous = JSON.parse(job.body), progress = progressInput(b.progress, previous.progress);
  if (progress.batches !== (previous.progress?.batches || 0)) throw new Error("invalid_progress");
  const inventory = await inventoryCommit(e, job, b);
  const statements = [];
  if (inventory) statements.push(inventory);
  if (b.nativeCheckpoint !== undefined && typeof b.nativeCheckpoint !== 'boolean') throw new Error('invalid_checkpoint');
  // Native intent/result snapshots keep the same existing running lease.
  // The ordinary checkpoint still releases it; neither path extends identity.
  const retain = b.nativeCheckpoint === true;
  if (retain && previous.stopRequested) throw new Error('job_stopped');
  const update = retain
    ? "UPDATE jobs SET body=json_set(body,'$.progress',json(?)) WHERE id=? AND lease=? AND status='running' AND COALESCE(json_extract(body,'$.stopRequested'),0)!=1"
    : "UPDATE jobs SET body=json_set(body,'$.progress',json(?)),status=CASE WHEN json_extract(body,'$.stopRequested')=1 THEN 'cancelled' ELSE 'pending' END,lease=NULL WHERE id=? AND lease=? AND status='running'";
  statements.push(e.DB.prepare(update).bind(JSON.stringify(progress), job.id, job.lease));
  const results = await e.DB.batch(statements);
  if (results.at(-1).meta.changes !== 1) return failure("job_conflict", 409);
  return json({ ok: true });
}

async function failJob(e, job, b) {
  const stage = jobFailureStage(b.stage);
  const reason = { code: jobFailureCode(b.reason), ...(stage ? { stage } : {}) };
  await e.DB.batch([
    e.DB.prepare(
      "UPDATE jobs SET body=json_set(body,'$.failure',json(?)),status='failed',lease=NULL WHERE id=? AND status='running'",
    ).bind(JSON.stringify(reason), job.id),
    e.DB.prepare("UPDATE state SET value=json_set(value,'$.enabled',json('false'),'$.nextRun',NULL,'$.pausedReason','failed','$.version',json_extract(value,'$.version')+1) WHERE key='automation' AND json_extract(value,'$.lastJobId')=?").bind(job.id),
  ]);
  return json({ ok: true });
}

async function complete(e, job, b) {
  if (
    !Array.isArray(b.drafts) ||
    b.drafts.length > 30 ||
    !Array.isArray(b.photos) ||
    b.photos.length > 300
  )
    throw new Error("invalid_batch");
  const previous = JSON.parse(job.body);
  if (previous.pipeline !== 2 || !validId(b.batchId) || typeof b.more !== "boolean") throw new Error("invalid_batch");
  const progress = progressInput(b.progress, previous.progress);
  if (progress.batches !== (previous.progress?.batches || 0) + 1 || progress.processed - (previous.progress?.processed || 0) > previous.maxPhotos || b.more !== (progress.processed < progress.total)) throw new Error("invalid_progress");
  if (progress.phase !== (b.more ? "processing" : "complete")) throw new Error("invalid_progress");
  if (previous.analysisLimit && (!Number.isInteger(b.progress.analyzed) || progress.analyzed > previous.analysisLimit || progress.analyzed - (previous.progress?.analyzed || 0) > progress.processed - (previous.progress?.processed || 0))) throw new Error('invalid_progress');
  const inventory = await inventoryCommit(e, job, b);
  const drafts = b.drafts.map(validateDraft),
    seen = new Set();
  if (new Set(drafts.map((d) => d.id)).size !== drafts.length)
    throw new Error("duplicate_draft");
  const crossChecks = Array.isArray(b.crossReviews) ? b.crossReviews : [];
  if (crossChecks.length && (crossChecks.length !== drafts.length || new Set(crossChecks.map(x => x?.draftId)).size !== drafts.length || crossChecks.some(x => !drafts.some(d => d.id === x?.draftId)))) throw new Error('invalid_batch');
  const photos = new Map(b.photos.map((p) => [p.id, p]));
  const stmts = inventory ? [inventory] : [];
  for (const d of drafts) {
    if (!d.id.startsWith(`${job.id}-${b.batchId}-`)) throw new Error("invalid_batch");
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
      if (photo.source) stmts.push(e.DB.prepare("INSERT OR IGNORE INTO state(key,value,expires) VALUES(?,?,NULL)").bind('photo-source:' + p.id, JSON.stringify(sourceRecord(photo.source))));
      stmts.push(
        e.DB.prepare("INSERT INTO photos(id,data,mime) VALUES(?,?,?)").bind(
          p.id,
          await storeImage(e, 'preview:' + p.id, raw),
          "image/jpeg",
        ),
      );
    }
    const evidence = Array.isArray(b.autoReviews) ? b.autoReviews.filter(x => x?.draftId === d.id) : [];
    const boundedEvidence = evidence.length === 1 ? { policy: evidence[0].policy, photoIds: evidence[0].photoIds, screens: Array.isArray(evidence[0].screens) ? evidence[0].screens.map(s => ({ id: s.id, decision: s.decision, landscape: s.landscape, flags: Array.isArray(s.flags) ? s.flags.slice(0, 8) : [], aesthetic: s.aesthetic, light: s.light, scene: s.scene, place: s.place })) : [], review: evidence[0].review } : null;
    const check = crossChecks.find(x => x?.draftId === d.id);
    if (check && (!Array.isArray(check.duplicateIds) || check.duplicateIds.length > 8 || new Set(check.duplicateIds).size !== check.duplicateIds.length || check.duplicateIds.some(id => !validId(id) || id === d.id) || typeof check.captionGrounded !== 'boolean' || typeof check.locationGrounded !== 'boolean')) throw new Error('invalid_batch');
    const crossReview = check ? { status: 'checked', duplicateIds: check.duplicateIds, captionGrounded: check.captionGrounded, locationGrounded: check.locationGrounded } : { status: 'unavailable' };
    const eligible = evidence.length === 1 && strictApproval(d, evidence[0], previous.reviewMode) && crossReview.status === 'checked' && !crossReview.duplicateIds.length && crossReview.captionGrounded && crossReview.locationGrounded;
    const reviewed = { ...d, crossReview, ...(boundedEvidence ? { strictReviewEvidence: boundedEvidence } : {}) };
    const approved = { ...reviewed, status: "approved", approvalSource: "strict_ai_v1", autoApprovedAt: Date.now(), strictReviewSoftFields: ownerPreferenceCounters(evidence[0]) };
    // Re-read the owner's mode inside the write transaction: switching to
    // manual during inference must prevent automatic approval at commit.
    stmts.push(e.DB.prepare("INSERT INTO drafts(id,body,version) SELECT ?,CASE WHEN ?=1 AND json_extract((SELECT value FROM state WHERE key='automation'),'$.reviewMode')='strict_auto' THEN ? ELSE ? END,1")
      .bind(d.id, eligible ? 1 : 0, JSON.stringify(approved), JSON.stringify(reviewed)));

  }
  stmts.push(
    e.DB.prepare(
      "UPDATE jobs SET body=json_set(body,'$.progress',json(?),'$.lastBatch',?),status=CASE WHEN json_extract(body,'$.stopRequested')=1 THEN 'cancelled' ELSE ? END,lease=NULL WHERE id=? AND lease=? AND status='running'",
    ).bind(JSON.stringify(progress), b.batchId, b.more ? (previous.analysisLimit && progress.analyzed >= previous.analysisLimit ? 'limited' : 'pending') : 'complete', job.id, job.lease),
  );
  await e.DB.batch(stmts);
  return json({ ok: true, count: drafts.length });
}

// Machine routes that act on one running job read the same body and prove the
// same lease before they run. Declaring that on the route, instead of letting
// control fall into a shared tail, is what makes the order unbreakable.
const internalRoutes = [
  { path: '/internal/inventory/status', methods: ['GET'], handle: (r, e) => inventoryStatus(e) },
  { path: '/internal/inventory', handle: (r, e) => inventoryRequest(r, e) },
  { path: '/internal/health', methods: ['GET'], handle: async (r, e) => json(await health.view(e)) },
  { path: '/internal/history-match', methods: ['POST'], handle: async (r, e) => json(await history.ingestMatches(e, await readJSON(r, BODY_LIMIT.history))) },
  { path: '/internal/history-media', methods: ['POST'], handle: async (r, e) => json(await instagram.mediaHistoryMediaPage(e, (await readJSON(r, BODY_LIMIT.small))?.offset ?? 0)) },
  { path: '/internal/instagram-check', methods: ['GET'], handle: async (r, e) => json(await instagram.publishingHealth(e)) },
  { path: '/internal/storage/migrate', methods: ['POST'], handle: async (r, e) => json(await migrateImages(e)) },
  { path: '/internal/travel-backfill', methods: ['POST'], handle: async (r, e) => json(await backfillTravel(e, (await readJSON(r, BODY_LIMIT.small)).cursor ?? null)) },
  { path: '/internal/autopublish', methods: ['POST'], handle: async (r, e) => {
    const result = await automatic(e, await readJSON(r, BODY_LIMIT.automatic));
    return result instanceof Response ? result : json(result);
  } },
  { path: '/internal/photo-sources', methods: ['GET', 'POST'], handle: (r, e) => photoSources(r, e) },
  { path: '/internal/cleanup-policy', methods: ['GET'], handle: async (r, e) => json({ enabled: (await settingsView(e)).settings.cleanupEnabled }) },
  { path: '/internal/maintenance', methods: ['POST'], handle: async (r, e) => {
    await maintenance(e, Date.now(), (await readJSON(r)).temporaryCleanup);
    return json({ ok: true });
  } },
  { path: '/internal/claim', methods: ['POST'], handle: (r, e) => claim(e) },
  { path: '/internal/source', methods: ['POST'], lease: true, handle: (r, e, job) => source(e, job) },
  { path: '/internal/checkpoint', methods: ['POST'], lease: true, handle: (r, e, job, b) => checkpoint(e, job, b) },
  { path: '/internal/fail', methods: ['POST'], lease: true, handle: (r, e, job, b) => failJob(e, job, b) },
  { path: '/internal/complete', methods: ['POST'], lease: true, handle: (r, e, job, b) => complete(e, job, b) },
];

const matches = (route, method, path) => route.path === path && (!route.methods || route.methods.includes(method));

async function internal(r, e, p) {
  if (!(await machine(r, e))) return failure("unauthorized", 401);
  const open = internalRoutes.find((route) => !route.lease && matches(route, r.method, p));
  if (open) return open.handle(r, e);
  // Every remaining route addresses one running job, so the lease check runs
  // once for all of them. A path that matches nothing still reports this same
  // malformed request, which is what the processor already handles.
  const b = await readJSON(r, BODY_LIMIT.batch);
  if (!validId(b.jobId) || typeof b.lease !== "string")
    return failure("invalid_job", 400);
  const job = await e.DB.prepare(
    "SELECT * FROM jobs WHERE id=? AND lease=? AND status='running'",
  )
    .bind(b.jobId, await auth.hash(b.lease))
    .first();
  if (!job) return failure("job_conflict", 409);
  const scoped = internalRoutes.find((route) => route.lease && matches(route, r.method, p));
  return scoped ? scoped.handle(r, e, job, b) : failure("not_found", 404);
}

// The owner's stored preferences are all "read, add, clamp, write back", and
// every one of them belongs to the same draft write. One helper keeps the guard
// with the write: a losing version conflict must not count the action anyway.
const CLAMP = 1000;
const bump = (value, by = 1) => Math.min(CLAMP, Number(value || 0) + by);

async function preferenceStatement(e, key, empty, apply, draft) {
  const value = apply({ ...empty, ...await auth.get(e, key) });
  return e.DB.prepare("INSERT INTO state(key,value,expires) SELECT ?,?,NULL WHERE EXISTS(SELECT 1 FROM drafts WHERE id=? AND body=?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(key, JSON.stringify(value), draft.id, draft.body);
}

async function route(r, e) {
  const u = new URL(r.url),
    p = u.pathname;
  if (p === "/api/session") {
    const s = await auth.session(r, e);
    const automation = s ? await auth.get(e, "automation") : null;
    return json({
      user: s ? { login: s.login } : null,
      githubConfigured: auth.configured(e),
      microsoftConfigured: auth.msConfigured(e),
      onedriveConnected: s ? Boolean(await auth.get(e, "microsoft")) : false,
      publishingIssue: s ? await publishing.issue(e) : undefined,
      publishingEnabled: s ? (await instagram.status(e)).connected : false,
      publishingSchedule: s ? {
        publishMode: automation?.publishMode || 'manual',
        reviewMode: automation?.reviewMode || 'manual',
        adaptive: automation?.adaptivePublishing === true,
        weekday: automation?.autoPublishWeekday ?? null,
        hour: automation?.autoPublishHour ?? null,
      } : undefined,
      instagram: s ? await instagram.status(e) : undefined,
      captionLanguage: s ? (e.AI_CAPTION_LANGUAGE||"en") : undefined,
    });
  }
  if (p === "/auth/github/start" && r.method === "GET")
    return auth.githubStart(r, e);
  if (p === "/auth/github/callback" && r.method === "GET")
    return auth.githubFinish(r, e);
  if(p.startsWith(PREFIX.delivery)&&r.method==='GET'){
    const parts=p.split('/');if(parts.length!==4||!validId(parts[2])||!validId(parts[3]))return failure('not_found',404);
    return publishing.media(e,parts[2],parts[3]);
  }
  if (p.startsWith("/internal/")) return internal(r, e, p);
  if (p.startsWith("/api/") || p.startsWith("/auth/")) {
    const user = await auth.session(r, e);
    if (!user) return failure("unauthorized", 401);
    if (
      !["GET", "HEAD"].includes(r.method) &&
      r.headers.get("Origin") !== u.origin
    )
      return failure("invalid_origin", 403);
    if(p==="/auth/instagram/start"&&r.method==="GET")return instagram.start(r,e);
    if(p==="/auth/instagram/callback"&&r.method==="GET")return instagram.finish(r,e);
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
    if(p.startsWith(PREFIX.publish)){
      const parts=p.slice(PREFIX.publish.length).split('/'),[id,publicationId,action,photoId]=parts;
      if(!parts.every(validId))return failure('not_found',404);
      if(parts.length===1&&r.method==='GET')return json(await publishing.view(e,id));
      if(parts.length===2&&publicationId==='prepare'&&r.method==='POST')return json(await publishing.prepare(e,id,(await readJSON(r)).version));
      if(parts.length===4&&action==='images'){
        if(r.method==='GET')return publishing.privateImage(e,id,publicationId,photoId);
        if(r.method==='POST'){
          if(r.headers.get('Content-Type')!=='image/jpeg')throw new Error('invalid_publish_image');
          const data=await readBytes(r,publishing.MAX_PUBLISH_IMAGE,'invalid_publish_image','invalid_publish_image');
          return json(await publishing.upload(e,id,publicationId,photoId,data));
        }
      }
      if(parts.length===3&&r.method==='POST'){
        const b=await readJSON(r);
        if(action==='recover')return json(await publishing.recover(e,id,publicationId,b.version,b.username));
        if(action==='begin')return json(await publishing.begin(e,id,publicationId,b.version,b.username));
        if(action==='advance')return json(await publishing.advance(e,id,publicationId));
      }
      return failure('not_found',404);
    }
    if (p === "/api/drafts" && r.method === "GET") {
      const rows = await e.DB.prepare(
        "SELECT body FROM drafts ORDER BY id",
      ).all();
      return json(await Promise.all(rows.results.map(async x=>{const d=JSON.parse(x.body);return {...d,publication:await publishing.view(e,d.id)};})));
    }
    if(p==='/api/history/sync' && r.method==='POST')return json(await history.sync(e));
    if(p==='/api/history' && r.method==='GET')return json(await history.summary(e));
    if(p==='/api/history/matches' && r.method==='GET'){
      return json(await history.matching(e));
    }
    if(p==='/api/history/matches/confirm' && r.method==='POST')return json(await history.confirmMatches(e,await readJSON(r,BODY_LIMIT.history)));
    if(p==='/api/history/matches/run' && r.method==='POST'){
      if(!(await auth.get(e,'microsoft')))return failure('onedrive_not_connected',409);
      const activeHistory=await e.DB.prepare("SELECT id,body FROM jobs WHERE status IN ('pending','running') AND json_extract(body,'$.mode')='history_match' ORDER BY created LIMIT 1").first();
      if(activeHistory){
        const activeBody=JSON.parse(activeHistory.body);
        if(activeBody.stopRequested===true){
          await e.DB.prepare("UPDATE jobs SET status='cancelled',lease=NULL WHERE id=? AND status IN ('pending','running')").bind(activeHistory.id).run();
        }else return failure('job_in_progress',409);
      }
      const running=await e.DB.prepare("SELECT id FROM jobs WHERE status IN ('pending','running') LIMIT 1").first();
      if(running)return failure('job_in_progress',409);
      const {settings}=await settingsView(e);
      const previous=await e.DB.prepare("SELECT body FROM jobs WHERE json_extract(body,'$.mode') IS NULL AND status IN ('complete','limited','failed') ORDER BY created DESC LIMIT 1").first();
      const savedRange=settings.folder?{folder:settings.folder,selection:{range:settings.range,start:settings.start||undefined},start:settings.range==='custom'||settings.range==='since'?settings.start:null,end:settings.range==='custom'?settings.end:null}:previous&&JSON.parse(previous.body);
      if(!savedRange)return failure('history_match_setup',409);
      const base=savedRange,id=crypto.randomUUID();
      const input={pipeline:2,mode:'history_match',folder:base.folder,selection:base.selection,start:base.start||null,end:base.end||null,maxPhotos:100,locationHint:'',progress:{phase:'scanning',total:0,processed:0,batches:0,analyzed:0},...jobLanguages(e)};
      await e.DB.prepare("INSERT INTO jobs(id,body,status,created) VALUES(?,?,'pending',?)").bind(id,JSON.stringify(input),Date.now()).run();
      return json({id,status:'pending',mode:'history_match'},201);
    }
    if(p==='/api/settings' && r.method==='GET')return json(await settingsView(e));
    if(p==='/api/storage/migrate'&&r.method==='POST')return json(await migrateImages(e));
    if(p==='/api/settings' && r.method==='PUT')return json(await saveSettings(e,await readJSON(r)));
    if (p === "/api/jobs" && r.method === "GET") {
      const rows = await e.DB.prepare(
        "SELECT id,status,created,body FROM jobs ORDER BY created DESC LIMIT 10",
      ).all();
      return json(rows.results.map(({body,...row})=>{
        const v=JSON.parse(body);
        return {...row,mode:v.mode||'selection',folder:v.folder,selection:v.selection,maxPhotos:v.maxPhotos,locationHint:v.locationHint||"",progress:v.progress,failure:v.failure||null,stopRequested:Boolean(v.stopRequested),scheduled:Boolean(v.scheduled),analysisLimit:v.analysisLimit};
      }));
    }
    if (p.startsWith(PREFIX.jobs) && p.endsWith("/stop") && r.method==="POST") {
      const id=p.slice(PREFIX.jobs.length,-"/stop".length);
      if(!validId(id)) return failure("not_found",404);
      const updated=await e.DB.prepare("UPDATE jobs SET body=json_set(body,'$.stopRequested',json('true')),status=CASE WHEN status='pending' OR json_extract(body,'$.mode')='history_match' THEN 'cancelled' ELSE status END,lease=CASE WHEN json_extract(body,'$.mode')='history_match' THEN NULL ELSE lease END WHERE id=? AND status IN ('pending','running')").bind(id).run();
      return updated.meta.changes===1?json({ok:true}):failure("job_conflict",409);
    }
    if (p === "/api/jobs" && r.method === "POST") {
      if (!(await auth.get(e, "microsoft")))
        return failure("onedrive_not_connected", 409);
      const {settings}=await settingsView(e);
      const input = {...jobInput(await readJSON(r)),...jobLanguages(e),reviewMode:settings.reviewMode,analysisLimit:settings.analysisLimit};
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
    if(p.startsWith(PREFIX.export) && r.method==='POST'){
      const parts=p.slice(PREFIX.export.length).split('/'),b=await readJSON(r);
      if(parts.length>2||!parts.every(validId)||!Number.isSafeInteger(b.version))throw new Error('invalid_request');
      if(parts.length===1){const d=await reviewedDraft(e,parts[0],b.version);return json(d);}
      return original(e,parts[0],parts[1],b.version);
    }
    if (p.startsWith(PREFIX.photos) && r.method === "GET") {
      const id = p.slice(PREFIX.photos.length);
      if (!validId(id)) return failure("not_found", 404);
      const row = await e.DB.prepare("SELECT data,mime FROM photos WHERE id=?")
        .bind(id)
        .first();
      return row
        ? readImage(e,'preview:'+id,row.data)
        : failure("not_found", 404);
    }
    if (p.startsWith(PREFIX.drafts) && r.method === "PATCH") {
      const id = p.slice(PREFIX.drafts.length);
      if (!validId(id)) return failure("not_found", 404);
      const row = await e.DB.prepare("SELECT body FROM drafts WHERE id=?")
        .bind(id)
        .first();
      if (!row) return failure("not_found", 404);
      const current = JSON.parse(row.body);
      const input=await readJSON(r);
      let next = reviewDraft(current, input);
      const removedPhotos=current.photos.filter(p=>!next.photos.some(q=>q.id===p.id));
      let ownerPreference=null;
      // reviewDraft already rejects an approval of changed content. Compare
      // its normalized result rather than raw JSON, which may omit defaults.
      if(input.action==='approve'&&next.status==='approved'){
        const automation=await auth.get(e,'automation');
        if(automation?.publishMode==='automatic'&&automation.reviewMode==='strict_auto'){
          ownerPreference=ownerPreferenceCounters(current.strictReviewEvidence);
          next={...next,approvalSource:'owner_scheduled_v1',ownerApprovedAt:Date.now(),...(ownerPreference?{ownerPreferenceCounters:ownerPreference}: {})};
        }
      }
      const draft={id,body:JSON.stringify(next)};
      const statements=[e.DB.prepare(
        "UPDATE drafts SET body=?,version=? WHERE id=? AND version=? AND NOT EXISTS(SELECT 1 FROM publications WHERE publications.draft_id=drafts.id AND status!='prepared')",
      )
        .bind(JSON.stringify(next), next.version, id, current.version)];
      for(const removed of removedPhotos){
        statements.push(e.DB.prepare("INSERT INTO photo_gc(photo_id,expires) SELECT ?,? WHERE EXISTS(SELECT 1 FROM drafts WHERE id=? AND body=?) ON CONFLICT(photo_id) DO UPDATE SET expires=excluded.expires")
          .bind(removed.id,Date.now()+RETENTION,id,JSON.stringify(next)));
      }
      if(ownerPreference){
        statements.push(await preferenceStatement(e,'ownerPreferenceCounters',{coherent:0,compositionGood:0,noDuplicateFrames:0},counters=>{
          for(const key of Object.keys(ownerPreference))if(ownerPreference[key]===1)counters[key]=bump(counters[key]);
          return counters;
        },draft));
      }
      if(input.action==='save'&&removedPhotos.length){
        statements.push(await preferenceStatement(e,'ownerCurationFeedback',{removedFromCarousel:0},feedback=>{
          feedback.removedFromCarousel=bump(feedback.removedFromCarousel,removedPhotos.length);
          return feedback;
        },draft));
      }
      if(input.action==='trash'&&next.ownerFeedback){
        const category=next.ownerFeedback.category;
        statements.push(await preferenceStatement(e,'ownerRejectionFeedback',{categories:{},recent:[]},feedback=>{
          feedback.categories[category]=bump(feedback.categories[category]);
          feedback.recent=[...(Array.isArray(feedback.recent)?feedback.recent:[]),{category,note:next.ownerFeedback.note}].slice(-20);
          return feedback;
        },draft));
      }
      const updated=await e.DB.batch(statements);
      if (updated[0].meta.changes !== 1) return failure("version_conflict", 409);
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
      return secure(errorResponse(err));
    }
  },
};
