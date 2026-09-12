import {settingsView} from './lifecycle.mjs';
import {status as instagramStatus} from './instagram.mjs';
import {issue as publicationIssue} from './publishing.mjs';

// Machine-only, read-only health data. Keep this response useful to an
// external monitor without exposing folders, captions, photo IDs or secrets.
function jobView(row){
 if(!row)return null;
 let body={};try{body=JSON.parse(row.body);}catch{}
 const progress=body.progress||{};
 return {id:row.id,status:row.status,created:row.created,scheduled:Boolean(body.scheduled),
   progress:{phase:progress.phase||null,total:Number.isSafeInteger(progress.total)?progress.total:0,
     processed:Number.isSafeInteger(progress.processed)?progress.processed:0,
     analyzed:Number.isSafeInteger(progress.analyzed)?progress.analyzed:0,
     batches:Number.isSafeInteger(progress.batches)?progress.batches:0}};
}

export async function view(e,now=Date.now()){
 const s=await settingsView(e,now);
 const last=await e.DB.prepare('SELECT id,status,created,body FROM jobs ORDER BY created DESC LIMIT 1').first();
 const ig=await instagramStatus(e);
 const issue=await publicationIssue(e);
 const warnings=[];
 if(s.storage?.full)warnings.push('storage_full');
 else if(s.storage?.warning)warnings.push('storage_warning');
 if(s.backlogPaused)warnings.push('review_backlog_paused');
 if(s.active)warnings.push('job_active');
 if(s.settings.enabled&&!s.settings.nextRun)warnings.push('schedule_missing');
 if(s.settings.enabled&&s.settings.publishMode==='automatic'&&(!ig.connected||ig.refreshState==='expired'))warnings.push('instagram_authorization');
 if(ig.refreshState==='failed')warnings.push('instagram_refresh_failed');
 if(issue)warnings.push(issue.status==='uncertain'?'publication_uncertain':'publication_attention');
 return {ok:warnings.length===0,checkedAt:now,warnings,
   automation:{enabled:Boolean(s.settings.enabled),publishMode:s.settings.publishMode,reviewMode:s.settings.reviewMode,
     frequency:s.settings.frequency,nextRun:s.settings.nextRun,lastRun:s.settings.lastRun||null,
     lastJobId:s.settings.lastJobId||null,pendingDrafts:s.pending,pendingLimit:s.settings.pendingLimit,
     backlogPaused:Boolean(s.backlogPaused)},
   cleanup:{enabled:Boolean(s.settings.cleanupEnabled),lastAt:s.cleanup?.lastAt||null,nextAt:s.cleanup?.nextAt||null,
     temporaryCleanup:s.temporaryCleanup?{at:s.temporaryCleanup.at,status:s.temporaryCleanup.status}:null},
   storage:s.storage?{backend:s.storage.backend,warning:Boolean(s.storage.warning),full:Boolean(s.storage.full),
     usedBytes:s.storage.usedBytes??null,limitBytes:s.storage.limitBytes??null,reads:s.storage.reads??null,
     writes:s.storage.writes??null,month:s.storage.month??null}:null,
   instagram:{configured:Boolean(ig.configured),connected:Boolean(ig.connected),username:ig.username||null,
     expires:ig.expires||null,autoRefresh:Boolean(ig.autoRefresh),refreshState:ig.refreshState||null,
     lastRenewedAt:ig.lastRenewedAt||null},
   publication:issue?{draftId:issue.draftId,status:issue.status,canRecover:Boolean(issue.canRecover),
     failure:issue.failure||null}:null,
   lastJob:jobView(last)};
}
