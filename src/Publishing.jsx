import React, {useState} from 'react';
import {useI18n} from './i18n.jsx';
async function request(path,body){
 const r=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':body instanceof Uint8Array?'image/jpeg':'application/json'},body:body instanceof Uint8Array?body:JSON.stringify(body)});
 if(!r.ok)throw new Error('publish_failed');return r.json();
}
export function nextOwnerWindow(schedule,now=Date.now()){
 if(!Number.isInteger(schedule?.hour)||schedule.hour<0||schedule.hour>23||(!schedule.adaptive&&(!Number.isInteger(schedule.weekday)||schedule.weekday<0||schedule.weekday>6)))return null;
 const local=new Date(now+8*3600000);
 let slot=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate()+(schedule.adaptive?0:(schedule.weekday-local.getUTCDay()+7)%7),schedule.hour)-8*3600000;
 if(slot<=now)slot+=(schedule.adaptive?1:7)*86400000;
 return slot;
}
export function Publishing({draft,onChange,disabled,schedule,onSettings}){
 const {t,date}=useI18n(),[state,setState]=useState(draft.publication),[busy,setBusy]=useState(false),[error,setError]=useState(false),[preview,setPreview]=useState(false);
 const base='/api/publish/'+draft.id;
 if(draft.approvalSource==='owner_scheduled_v1') return <section className="publication" aria-label={t('Instagram publishing')}>
  <h3>{t('Instagram publishing')}</h3>
  {state?.status==='published'?<p role="status">{t('Published · Instagram ID {id}',{id:state.mediaId})}</p>:
   schedule?.publishMode!=='automatic'||schedule?.reviewMode!=='strict_auto'?<p role="status">{t('自动发布已关闭；批准稿会留在队列中。')}</p>:
   nextOwnerWindow(schedule)===null?<>
    <p role="status">{t('人工排期尚未设置；人工批准稿会继续留在队列中。')}</p>
    <button className="text-button" onClick={onSettings}>{t('设置人工发布时间')}</button>
   </>:<>
    <p role="status">{t('下一个可用发布窗口：{time}',{time:date(nextOwnerWindow(schedule))})}</p>
    <p className="muted">{schedule.adaptive?t('实际发布间隔按已批准队列积压量调整，每天最多一篇；前次尝试或授权问题会延后。'):t('每七天最多一次发布尝试；如有前次尝试或授权问题，可能继续等待。')}</p>
   </>}
 </section>;
 const refresh=async()=>{const next=await request(base);setState(next);return next;};
 const prepare=async()=>{
  setBusy(true);setError(false);
  try{
   const {renderDraft}=await import('./export.mjs');const {approved,files}=await renderDraft(draft);
   const next=await request(base+'/prepare',{version:approved.version});setState(next);
   for(let i=0;i<approved.photos.length;i++)await request(base+'/'+next.id+'/images/'+approved.photos[i].id,files[String(i+1).padStart(2,'0')+'.jpg']);
   setPreview(true);
  }catch{setError(true);}finally{setBusy(false);}
 };
 const publish=async(start)=>{
  setBusy(true);setError(false);
  try{
   let next=start?await request(base+'/'+state.id+(start==='recover'?'/recover':'/begin'),{version:draft.version,username:state.username}):await refresh();
   setState(next);onChange(next);
   for(let i=0;i<120&&['publishing','working'].includes(next.status);i++){
    next=next.status==='working'?await refresh():await request(base+'/'+next.id+'/advance',{});
    setState(next);onChange(next);
    if(['publishing','working'].includes(next.status))await new Promise(resolve=>setTimeout(resolve,Math.max(1500,next.retryAfterMs||0)));
   }
  }catch{setError(true);try{const next=await refresh();onChange(next);}catch{}}
  finally{setBusy(false);}
 };
 return <section className="publication" aria-label={t('Instagram publishing')}>
  <h3>{t('Instagram publishing')}</h3>
  {(!state||state.status==='prepared')&&<>
   <button className="button secondary" disabled={busy||disabled} onClick={prepare}>{t(busy?'Preparing images…':'Prepare Instagram post')}</button>
   {preview&&state&&<>
    <p>{t('Review the exact images before publishing.')}</p>
    <div className="publication-preview">{draft.photos.map((p,i)=><img key={p.id} src={base+'/'+state.id+'/images/'+p.id} alt={p.alt} />)}</div>
    <p className="muted">{t('Images become accessible to Instagram after publishing starts and expire after one hour.')}</p>
    <button className="button primary" disabled={busy||disabled} onClick={()=>publish(true)}>{t('Publish to @{username}',{username:state.username})}</button>
   </>}
  </>}
  {state&&['publishing','working'].includes(state.status)&&<button className="button primary" disabled={busy||disabled} onClick={()=>publish(false)}>{t(busy?'Publishing…':'Continue publishing')}</button>}
  {state?.status==='published'&&<p role="status">{t('Published · Instagram ID {id}',{id:state.mediaId})}</p>}
  {state?.canRecover&&<button className="button secondary" disabled={busy||disabled} onClick={()=>publish('recover')}>{t('Resume after account verification')}</button>}
  {state?.failure&&<p role="alert">{t(state.failure.category==='authorization'?'Instagram authorization needs attention':'Instagram publication needs attention')}</p>}
  {state?.status==='uncertain'&&<p role="alert">{t('Publishing outcome uncertain. Check Instagram; automatic retries are blocked.')}</p>}
  {error&&<p role="alert">{t('Could not finish. Check Instagram connection, approval, and image size.')}</p>}
 </section>;
}
