import {get} from './auth.mjs';
import {original,reviewedDraft} from './originals.mjs';
import {publishingAccount} from './instagram.mjs';
import * as publishing from './publishing.mjs';
import {storageView} from './storage.mjs';

const DAY=86400000;
const fail=()=>{throw new Error('publication_conflict');};
const fields=['privacySafe','captionGrounded','locationGrounded','coherent','compositionGood','noDuplicateFrames'];
export function eligible(d,s){
 return s?.publishMode==='automatic'&&s.reviewMode==='strict_auto'&&Number.isSafeInteger(s.autoPublishSince)&&
  d.status==='approved'&&d.approvalSource==='strict_ai_v1'&&Number.isSafeInteger(d.autoApprovedAt)&&d.autoApprovedAt>s.autoPublishSince&&
  d.photos.every(p=>p.frame?.mode==='crop');
}
// Every machine operation is checked against current owner settings. The batch
// credential is trusted to submit AI evidence, but cannot enable this mode.
export async function automatic(e,b){
 const s=await get(e,'automation');
 if(s?.publishMode!=='automatic'||s.reviewMode!=='strict_auto'){
  if(b.action==='candidate')return null;fail();
 }
 const account=await publishingAccount(e);
 if(account.userId!==s.autoPublishUserId)fail();
 if(b.action==='candidate'){
  if((await storageView(e)).full)return null;
  // Ambiguous requests need owner investigation; never start another post.
  if(await e.DB.prepare("SELECT id FROM publications WHERE status IN ('working','uncertain') LIMIT 1").first())return null;
  const active=await e.DB.prepare("SELECT draft_id FROM publications WHERE status='publishing' AND json_extract(body,'$.automatic')=1 LIMIT 1").first();
  if(active){
   const d=await reviewedDraft(e,active.draft_id,(await publishing.view(e,active.draft_id)).version);
   const activeRow=await e.DB.prepare('SELECT body FROM publications WHERE draft_id=?').bind(d.id).first();
   if(!eligible(d,s)||JSON.parse(activeRow.body).autoPublishSince!==s.autoPublishSince)return null;
   return {draft:d,publication:await publishing.view(e,d.id)};
  }
  // Prepared work is never automatically reclaimed after a crash. It remains
  // private for manual inspection. This also bounds failed reviews to one/day.
  if(await e.DB.prepare("SELECT id FROM publications WHERE created>? OR status IN ('publishing','working','uncertain') LIMIT 1").bind(Date.now()-DAY).first())return null;
  const rows=await e.DB.prepare("SELECT body FROM drafts WHERE json_extract(body,'$.status')='approved' AND json_extract(body,'$.approvalSource')='strict_ai_v1' AND json_extract(body,'$.autoApprovedAt')>? AND NOT EXISTS(SELECT 1 FROM publications WHERE publications.draft_id=drafts.id) ORDER BY json_extract(body,'$.autoApprovedAt') LIMIT 100").bind(s.autoPublishSince).all();
  const d=rows.results.map(r=>JSON.parse(r.body)).find(d=>eligible(d,s));
  if(!d)return null;
  const publication=await publishing.prepare(e,d.id,d.version,{since:s.autoPublishSince,userId:s.autoPublishUserId});
  return {draft:d,publication};
 }
 const p=await e.DB.prepare('SELECT * FROM publications WHERE draft_id=? AND id=?').bind(b.draftId,b.publicationId).first();
 if(!p)fail();const body=JSON.parse(p.body);
 if(!body.automatic||body.autoPublishSince!==s.autoPublishSince||body.userId!==s.autoPublishUserId)fail();
 const d=await reviewedDraft(e,b.draftId,p.version);
 if(!eligible(d,s)||b.version!==d.version)fail();
 if(b.action==='advance')return publishing.advance(e,d.id,p.id);
 if(p.status!=='prepared'||p.expires<=Date.now()||body.autoBlocked)fail();
 if(b.action==='original')return original(e,d.id,b.photoId,d.version);
 if(b.action==='upload'){
  if(typeof b.data!=='string'||b.data.length>2400000)fail();
  return publishing.upload(e,d.id,p.id,b.photoId,Uint8Array.from(atob(b.data),c=>c.charCodeAt(0)));
 }
 if(b.action==='reject'){
  await e.DB.batch([
   e.DB.prepare("UPDATE publications SET body=json_set(body,'$.autoBlocked',1) WHERE id=? AND status='prepared'").bind(p.id),
   e.DB.prepare("UPDATE drafts SET version=version+1,body=json_remove(json_set(body,'$.status','draft','$.version',version+1),'$.approvalSource','$.autoApprovedAt') WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM publications WHERE id=? AND status='prepared' AND json_extract(body,'$.autoBlocked')=1)").bind(d.id,d.version,p.id),
  ]);
  return {ok:true};
 }
 if(b.action==='begin'){
  const r=b.review;
  if(!r||fields.some(k=>r[k]!==true)||r.needsHumanReview!==false)fail();
  const images=(await e.DB.prepare('SELECT photo_id,digest FROM publication_images WHERE publication_id=?').bind(p.id).all()).results;
  if(!Array.isArray(b.images)||images.length!==d.photos.length||b.images.length!==images.length||
    !d.photos.every((photo,i)=>b.images[i]?.id===photo.id&&images.some(x=>x.photo_id===photo.id&&x.digest===b.images[i]?.digest)))fail();
  // Bind the independent original-resolution review to the exact stored files.
  const result=await e.DB.prepare("UPDATE publications SET body=json_set(body,'$.originalReview',json(?)) WHERE id=? AND status='prepared' AND body=?")
   .bind(JSON.stringify({images:b.images,review:r}),p.id,p.body).run();
  if(result.meta.changes!==1)fail();
  return publishing.begin(e,d.id,p.id,d.version,account.username);
 }
 fail();
}
