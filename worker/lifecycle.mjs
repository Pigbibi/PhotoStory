import {refresh as refreshInstagram} from './instagram.mjs';
import {cleanup as cleanupPublications} from './publishing.mjs';
import {jobLanguages} from './languages.mjs';
import {get,put} from './auth.mjs';
import {jobInput} from './jobs.mjs';
export const DAY=86400000, RETENTION=30*DAY;
export const defaults={reviewMode:"manual",version:0,enabled:false,frequency:'weekly',weekday:1,monthDay:1,hour:9,
  folder:'',range:'1m',maxPhotos:20,analysisLimit:100,pendingLimit:20,cleanupEnabled:true,nextRun:null};
export function nextRun(s,now){
  const local=new Date(now+8*3600000);
  if(s.frequency==='weekly'){
    let value=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate()+(s.weekday-local.getUTCDay()+7)%7,s.hour)-8*3600000;
    if(value<=now)value+=7*DAY;
    return value;
  }
  for(let i=0;i<2;i++){
    const y=local.getUTCFullYear(),m=local.getUTCMonth()+i;
    const last=new Date(Date.UTC(y,m+1,0)).getUTCDate();
    const value=Date.UTC(y,m,Math.min(s.monthDay,last),s.hour)-8*3600000;
    if(value>now)return value;
  }
}
export function settingsInput(b,now=Date.now()){
  const s={reviewMode:b.reviewMode??"manual"};
  if(!["manual","strict_auto"].includes(s.reviewMode))throw new Error("invalid_settings");
  for(const k of ['enabled','cleanupEnabled']){
    if(typeof b[k]!=='boolean')throw new Error('invalid_settings');s[k]=b[k];
  }
  for(const [k,min,max] of [['weekday',0,6],['monthDay',1,31],['hour',0,23],['analysisLimit',1,1000],['pendingLimit',1,100]]){
    if(!Number.isInteger(b[k])||b[k]<min||b[k]>max)throw new Error('invalid_settings');s[k]=b[k];
  }
  if(!['weekly','monthly'].includes(b.frequency)||!['1m','3m','6m','12m','all'].includes(b.range))throw new Error('invalid_settings');
  const source=jobInput({folder:b.folder||(!b.enabled?'Photos':''),range:b.range,maxPhotos:b.maxPhotos},new Date(now));
  return {...s,frequency:b.frequency,folder:b.folder?source.folder:'',range:b.range,maxPhotos:source.maxPhotos,nextRun:s.enabled?nextRun({...s,frequency:b.frequency},now):null};
}
export async function settingsView(e,now=Date.now()){
  const settings={...defaults,...await get(e,'automation')};
  const pending=(await e.DB.prepare("SELECT count(*) AS n FROM drafts WHERE json_extract(body,'$.status')='draft'").first()).n;
  const active=await e.DB.prepare("SELECT id,status FROM jobs WHERE status IN ('pending','running') LIMIT 1").first();
  const cleanup=await get(e,'cleanup')||{lastAt:null,nextAt:null};
  return {settings,pending,active,backlogPaused:pending>=settings.pendingLimit,cleanup,
    temporaryCleanup:await get(e,'temporaryCleanup'),retentionDays:30,now};
}
export async function saveSettings(e,b,now=Date.now()){
  const previous={...defaults,...await get(e,'automation')};
  if(b.version!==previous.version)throw new Error('version_conflict');
  const next={...previous,...settingsInput(b,now),pausedReason:null,version:previous.version+1};
  const row=await e.DB.prepare("INSERT INTO state(key,value,expires) VALUES('automation',?,NULL) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE json_extract(state.value,'$.version')=?")
    .bind(JSON.stringify(next),previous.version).run();
  if(row.meta.changes!==1)throw new Error('version_conflict');
  return settingsView(e,now);
}
export async function maintenance(e,now=Date.now(),temporaryCleanup=null){
  await refreshInstagram(e,now).catch(()=>{});
  await cleanupPublications(e,now);
  if(temporaryCleanup && ['ok','busy','error','disabled'].includes(temporaryCleanup.status) && Number.isSafeInteger(temporaryCleanup.at) && temporaryCleanup.at<=now+60000 && temporaryCleanup.at>now-7*DAY){
    const safe={at:temporaryCleanup.at,status:temporaryCleanup.status};
    for(const k of ['files','directories'])if(Number.isSafeInteger(temporaryCleanup[k])&&temporaryCleanup[k]>=0)safe[k]=temporaryCleanup[k];
    const old=await get(e,'temporaryCleanup');
    if(!old||old.at<safe.at)await put(e,'temporaryCleanup',safe);
  }
  let view=await settingsView(e,now);
  if(view.settings.cleanupEnabled && (!view.cleanup.nextAt||view.cleanup.nextAt<=now)){
    // One transaction: collect expiring references, remove expired trash, then
    // delete only unreferenced previews. A concurrent restore cannot lose its image.
    const expired="json_extract(body,'$.status')='trash' AND json_type(body,'$.trashedAt')='integer' AND json_extract(body,'$.trashedAt')<=?";
    const local=new Date(now+8*3600000);
    const nextDay=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate(),4)-8*3600000;
    const cleanup={lastAt:now,nextAt:nextDay>now?nextDay:nextDay+DAY};
    await e.DB.batch([
      e.DB.prepare(`INSERT OR IGNORE INTO photo_gc(photo_id,expires) SELECT json_extract(p.value,'$.id'),? FROM drafts,json_each(drafts.body,'$.photos') p WHERE ${expired}`).bind(now,now-RETENTION),
      e.DB.prepare(`DELETE FROM drafts WHERE ${expired}`).bind(now-RETENTION),
      e.DB.prepare("DELETE FROM photos WHERE id IN (SELECT photo_id FROM photo_gc WHERE expires<=?) AND NOT EXISTS(SELECT 1 FROM drafts,json_each(drafts.body,'$.photos') p WHERE json_extract(p.value,'$.id')=photos.id)").bind(now),
      e.DB.prepare("DELETE FROM state WHERE key LIKE 'photo-source:%' AND NOT EXISTS(SELECT 1 FROM photos WHERE state.key='photo-source:'||photos.id)").bind(),
      e.DB.prepare('DELETE FROM photo_gc WHERE NOT EXISTS(SELECT 1 FROM photos WHERE photos.id=photo_gc.photo_id)').bind(),
      e.DB.prepare("INSERT INTO state(key,value,expires) VALUES('cleanup',?,NULL) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(cleanup)),
    ]);
  }
  const s=view.settings;
  if(!s.enabled||s.nextRun>now||view.active||view.backlogPaused||!await get(e,'microsoft'))return;
  const id=crypto.randomUUID(),body={...jobInput(s,new Date(now)),...jobLanguages(e),reviewMode:s.reviewMode,analysisLimit:s.analysisLimit,scheduled:true};
  // Claim this schedule slot and advance its date in the same transaction. Missed
  // periods collapse to one run; a failed job is never automatically retried.
  await e.DB.batch([
    e.DB.prepare("INSERT INTO jobs(id,body,status,created) SELECT ?,?,'pending',? FROM state WHERE key='automation' AND json_extract(value,'$.enabled')=1 AND json_extract(value,'$.version')=? AND json_extract(value,'$.nextRun')=? AND NOT EXISTS(SELECT 1 FROM jobs WHERE status IN ('pending','running')) AND (SELECT count(*) FROM drafts WHERE json_extract(body,'$.status')='draft')<?")
      .bind(id,JSON.stringify(body),now,s.version,s.nextRun,s.pendingLimit),
    e.DB.prepare("UPDATE state SET value=json_set(value,'$.nextRun',?,'$.lastRun',?,'$.lastJobId',?) WHERE key='automation' AND EXISTS(SELECT 1 FROM jobs WHERE id=?)")
      .bind(nextRun(s,now),now,id,id),
  ]);
}
