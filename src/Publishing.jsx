import React, {useState} from 'react';
import {useI18n} from './i18n.jsx';
async function request(path,body){
 const r=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':body instanceof Uint8Array?'image/jpeg':'application/json'},body:body instanceof Uint8Array?body:JSON.stringify(body)});
 if(!r.ok)throw new Error('publish_failed');return r.json();
}
export function Publishing({draft,onChange,disabled}){
 const {t}=useI18n(),[state,setState]=useState(draft.publication),[busy,setBusy]=useState(false),[error,setError]=useState(false),[preview,setPreview]=useState(false);
 const base='/api/publish/'+draft.id;
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
   let next=start?await request(base+'/'+state.id+'/begin',{version:draft.version,username:state.username}):await refresh();
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
  {state?.status==='uncertain'&&<p role="alert">{t('Publishing outcome uncertain. Check Instagram; automatic retries are blocked.')}</p>}
  {error&&<p role="alert">{t('Could not finish. Check Instagram connection, approval, and image size.')}</p>}
 </section>;
}
