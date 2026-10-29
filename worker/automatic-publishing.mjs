import {get,hash} from './auth.mjs';
import {original,reviewedDraft} from './originals.mjs';
import {publishingAccount} from './instagram.mjs';
import * as publishing from './publishing.mjs';
import {storageView} from './storage.mjs';

const fail=()=>{throw new Error('publication_conflict');};
const fields=['privacySafe','captionGrounded','locationGrounded','coherent','compositionGood','noDuplicateFrames'];
export function scheduledWindowOpen(s,now=Date.now()){
 if(!Number.isInteger(s?.autoPublishHour))return false;
 const local=new Date(now+8*3600000);
 return local.getUTCHours()===s.autoPublishHour&&(s.adaptivePublishing===true||local.getUTCDay()===s.autoPublishWeekday);
}
export function adaptiveInterval(backlog){
 return backlog>=6?24*3600000:backlog>=3?3*24*3600000:publishing.AUTO_PUBLISH_INTERVAL;
}
export function sameTrip(left,right){
 const a=left?.travel,b=right?.travel;
 if(!Number.isSafeInteger(a?.day)||!Number.isSafeInteger(b?.day))return false;
 const days=Math.abs(a.day-b.day);
 if(days>21)return false;
 if(!Array.isArray(a.area)||!Array.isArray(b.area))return days<=10;
 const [lat1,lon1]=a.area.map(x=>x*Math.PI/180),[lat2,lon2]=b.area.map(x=>x*Math.PI/180);
 const h=Math.sin((lat2-lat1)/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin((lon2-lon1)/2)**2;
 return 12742*Math.asin(Math.min(1,Math.sqrt(h)))<=900;
}
export function claimedEligible(d,s){
 const owner=d.approvalSource==='owner_scheduled_v1';
 return s?.publishMode==='automatic'&&s.reviewMode==='strict_auto'&&Number.isSafeInteger(s.autoPublishSince)&&
  d.status==='approved'&&(d.approvalSource==='strict_ai_v1'||owner)&&Number.isSafeInteger(owner?d.ownerApprovedAt:d.autoApprovedAt)&&
  (owner?d.ownerApprovedAt:d.autoApprovedAt)>s.autoPublishSince&&d.photos.every(p=>p.frame?.mode==='crop');
}
export function eligible(d,s,now=Date.now()){
 const owner=d.approvalSource==='owner_scheduled_v1';
 return claimedEligible(d,s)&&(!(owner||s.adaptivePublishing)||scheduledWindowOpen(s,now));
}
// Every machine operation is checked against current owner settings. The batch
// credential is trusted to submit AI evidence, but cannot enable this mode.
async function nativeCheckpoint(checkpoint,d,p){
 if(!checkpoint||Object.keys(checkpoint).sort().join()!=='operation,value'||JSON.stringify(checkpoint).length>16384)fail();
 const v=checkpoint.value,x=v?.binding;
 const operation='photostory:'+await hash(JSON.stringify(['Pigbibi/PhotoStory','publication',{draftId:d.id,publicationId:p.id,version:d.version}]));
 const id=await hash(JSON.stringify([operation,'publication',d.photos.map(x=>x.id).sort()]));
 if(checkpoint.operation!==id||x?.project!=='Pigbibi/PhotoStory'||x.operation_id!==operation||
  !/^[0-9a-f]{64}$/.test(x.request_sha256||'')||!Number.isFinite(x.deadline)||x.deadline>p.expires/1000||
  typeof x.resource!=='string'||x.route?.mode!=='agent'||!['dot','grok'].includes(x.route.provider)||
  ['intent','halt','cancel'].some(k=>typeof v[k]!=='boolean')||
  !(v.task_id===null||(typeof v.task_id==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(v.task_id)))||
  !(v.revision===null||(Number.isInteger(v.revision)&&v.revision>=1))||
  !(v.task_deadline===null||Number.isFinite(v.task_deadline)))fail();
 const url=new URL(x.resource);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)fail();
 if(!v.halt&&!v.cancel&&!v.task_id&&x.deadline<=Date.now()/1000)fail();
 if(v.claim!==null&&(!Array.isArray(v.claim)||v.claim.length!==3||v.claim[0]!==x.route.worker||typeof v.claim[1]!=='string'||!v.claim[1]||v.claim[2]!==v.revision))fail();
 if(v.output_sha256!==null&&!/^[0-9a-f]{64}$/.test(v.output_sha256))fail();
 if(v.accepted_output!==undefined){
  const completed=v.completed_at??v.accepted_at; // Existing timely receipts remain readable.
  if(!v.claim||!Number.isFinite(completed)||!Number.isFinite(v.accepted_at)||
   completed<0||completed>v.accepted_at||completed>=Math.min(x.deadline,v.task_deadline)||
   v.accepted_at>=x.deadline||v.accepted_at>Date.now()/1000)fail();
 }
 return checkpoint;
}
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
   if(!claimedEligible(d,s)||JSON.parse(activeRow.body).autoPublishSince!==s.autoPublishSince)return null;
   return {draft:d,publication:await publishing.view(e,d.id)};
  }
  // A known native wait/cache resumes only this existing unexpired prepared
  // publication. Unknown intent, external begin uncertainty and owner gates hold.
  const waitingNative=await e.DB.prepare("SELECT * FROM publications WHERE status='prepared' AND expires>? AND json_extract(body,'$.automatic')=1 AND COALESCE(json_extract(body,'$.autoBlocked'),0)=0 AND json_extract(body,'$.nativeReview.value.intent')=1 AND json_extract(body,'$.nativeReview.value.task_id') IS NOT NULL AND json_extract(body,'$.nativeReview.value.halt')=0 AND json_extract(body,'$.nativeReview.value.cancel')=0 LIMIT 1").bind(Date.now()).first();
  if(waitingNative){
   const d=await reviewedDraft(e,waitingNative.draft_id,waitingNative.version),body=JSON.parse(waitingNative.body);
   if(!claimedEligible(d,s)||body.autoPublishSince!==s.autoPublishSince||body.userId!==s.autoPublishUserId)return null;
   const checkpoint=await nativeCheckpoint(body.nativeReview,d,waitingNative);
   return {draft:d,publication:await publishing.view(e,d.id),nativeCheckpoint:checkpoint};
  }
  // Only an explicit owner recovery can reclaim a prepared automatic post.
  // Consume that permission once; a crashed preparation stays blocked.
  const recovery=await e.DB.prepare("SELECT * FROM publications WHERE status='prepared' AND json_extract(body,'$.automatic')=1 AND json_extract(body,'$.recoveryPending')=1 LIMIT 1").first();
  if(recovery){
   const d=await reviewedDraft(e,recovery.draft_id,recovery.version),body=JSON.parse(recovery.body);
   if(!claimedEligible(d,s)||body.autoPublishSince!==s.autoPublishSince||body.userId!==s.autoPublishUserId)return null;
   const now=Date.now();delete body.recoveryPending;body.touched=now;
   const claimed=await e.DB.prepare("UPDATE publications SET body=?,created=?,expires=? WHERE id=? AND status='prepared' AND body=? AND NOT EXISTS(SELECT 1 FROM publications WHERE status IN ('publishing','working','uncertain')) AND EXISTS(SELECT 1 FROM drafts WHERE id=? AND version=? AND json_extract(body,'$.status')='approved') AND EXISTS(SELECT 1 FROM state WHERE key='automation' AND json_extract(value,'$.publishMode')='automatic' AND json_extract(value,'$.reviewMode')='strict_auto' AND json_extract(value,'$.autoPublishSince')=? AND json_extract(value,'$.autoPublishUserId')=?)")
    .bind(JSON.stringify(body),now,now+3600000,recovery.id,recovery.body,d.id,d.version,s.autoPublishSince,s.autoPublishUserId).run();
   return claimed.meta.changes===1?{draft:d,publication:await publishing.view(e,d.id)}:null;
  }
  const rows=await e.DB.prepare("SELECT body FROM drafts WHERE json_extract(body,'$.status')='approved' AND json_extract(body,'$.approvalSource') IN ('strict_ai_v1','owner_scheduled_v1') AND (json_extract(body,'$.autoApprovedAt')>? OR json_extract(body,'$.ownerApprovedAt')>?) AND NOT EXISTS(SELECT 1 FROM publications WHERE publications.draft_id=drafts.id) ORDER BY COALESCE(json_extract(body,'$.autoApprovedAt'),json_extract(body,'$.ownerApprovedAt')) LIMIT 100").bind(s.autoPublishSince,s.autoPublishSince).all();
  const waiting=rows.results.map(r=>JSON.parse(r.body)).filter(d=>claimedEligible(d,s));
  const interval=s.adaptivePublishing?adaptiveInterval(waiting.length):publishing.AUTO_PUBLISH_INTERVAL;
  // Prepared work is never reclaimed after a crash. A recent attempt and any
  // ambiguous operation block the next post even when the queue grows.
  if(await e.DB.prepare("SELECT id FROM publications WHERE created>? OR status IN ('publishing','working','uncertain') LIMIT 1").bind(Date.now()-interval).first())return null;
  const ready=waiting.filter(d=>eligible(d,s));
  if(!ready.length)return null;
  const last=await e.DB.prepare("SELECT d.body FROM publications p JOIN drafts d ON d.id=p.draft_id WHERE p.status='published' ORDER BY p.created DESC LIMIT 1").first();
  const anchor=last?JSON.parse(last.body):null;
  const d=anchor?ready.find(d=>sameTrip(d,anchor))||ready[0]:ready[0];
  const publication=await publishing.prepare(e,d.id,d.version,{since:s.autoPublishSince,userId:s.autoPublishUserId,ownerScheduled:d.approvalSource==='owner_scheduled_v1',adaptive:s.adaptivePublishing===true,interval});
  return {draft:d,publication};
 }
 const p=await e.DB.prepare('SELECT * FROM publications WHERE draft_id=? AND id=?').bind(b.draftId,b.publicationId).first();
 if(!p)fail();const body=JSON.parse(p.body);
 if(!body.automatic||body.autoPublishSince!==s.autoPublishSince||body.userId!==s.autoPublishUserId)fail();
 const d=await reviewedDraft(e,b.draftId,p.version);
 if(!claimedEligible(d,s)||b.version!==d.version)fail();
 if(b.action==='advance')return publishing.advance(e,d.id,p.id);
 if(p.status!=='prepared'||p.expires<=Date.now()||body.autoBlocked)fail();
 if(b.action==='native_checkpoint'){
  const next=await nativeCheckpoint(b.checkpoint,d,p),old=body.nativeReview;
  if(old){
   // cancel=true/halt=false reserves the one sender before its RPC. An
   // identical stale copy must stop, including after a lost acknowledgement.
   // The original sender may still persist halt=true after its attempt.
   if(old.value.cancel&&next.value.cancel&&!next.value.halt)fail();
   if(old.operation!==next.operation||JSON.stringify(old.value.binding)!==JSON.stringify(next.value.binding))fail();
   for(const key of ['task_id','revision','task_deadline','claim','output_sha256']){
    if(old.value[key]!==null&&JSON.stringify(old.value[key])!==JSON.stringify(next.value[key]))fail();
   }
   if(['intent','halt','cancel'].some(k=>old.value[k]&&!next.value[k]))fail();
   if(old.value.accepted_output!==undefined&&(JSON.stringify(old.value.accepted_output)!==JSON.stringify(next.value.accepted_output)||old.value.accepted_at!==next.value.accepted_at||old.value.completed_at!==next.value.completed_at))fail();
  }
  const updated={...body,nativeReview:next};
  const result=await e.DB.prepare("UPDATE publications SET body=? WHERE id=? AND status='prepared' AND body=? AND expires>? AND EXISTS(SELECT 1 FROM drafts WHERE id=? AND version=? AND json_extract(body,'$.status')='approved') AND EXISTS(SELECT 1 FROM state WHERE key='automation' AND json_extract(value,'$.publishMode')='automatic' AND json_extract(value,'$.reviewMode')='strict_auto' AND json_extract(value,'$.autoPublishSince')=? AND json_extract(value,'$.autoPublishUserId')=?)")
   .bind(JSON.stringify(updated),p.id,p.body,Date.now(),d.id,d.version,s.autoPublishSince,s.autoPublishUserId).run();
  if(result.meta.changes!==1)fail();return {ok:true};
 }
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
  const r=d.approvalSource==='owner_scheduled_v1'
   ? {privacySafe:true,captionGrounded:true,locationGrounded:true,coherent:true,compositionGood:true,noDuplicateFrames:true,needsHumanReview:false}
   : b.review;
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
