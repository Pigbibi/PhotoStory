import React,{useEffect,useState} from 'react';
import {useI18n} from './i18n.jsx';
export default function History({api}){
 const {t}=useI18n(),[data,setData]=useState(null),[matching,setMatching]=useState(null),[failed,setFailed]=useState(false),[busy,setBusy]=useState(false),[confirming,setConfirming]=useState(false),[running,setRunning]=useState(false);
 useEffect(()=>{api('/api/history').then(setData).catch(()=>setFailed(true));api('/api/history/matches').then(setMatching).catch(()=>setMatching(null));},[]);
 const confirmMatches=async()=>{if(!matching?.proposals?.length)return;setConfirming(true);setFailed(false);try{const value=await api('/api/history/matches/confirm','POST',{matches:matching.proposals.map(({instagramId,photoId})=>({instagramId,photoId}))});setMatching(value);setData(await api('/api/history'));}catch{setFailed(true);}finally{setConfirming(false);}};
 const runMatching=async()=>{setRunning(true);setFailed(false);try{await api('/api/history/matches/run','POST',{});}catch{setFailed(true);}finally{setRunning(false);}};
 return <section className="settings-panel">
  <h2>{t('Publication history')}</h2>
  <p>{t('Published records remain after Instagram deletion or temporary image cleanup.')}</p>
  {failed&&<p role="alert">{t('操作没有完成。请检查连接状态；未自动重试。')}</p>}
  <button disabled={busy||!data} onClick={async()=>{setBusy(true);setFailed(false);try{setData(await api('/api/history/sync','POST',{}));}catch{setFailed(true);}finally{setBusy(false);}}}>{t('Read Instagram history page')}</button>
  {data&&<>
   {data.instagram&&<p>{t('Instagram history totals',{posts:data.instagram.posts,photos:data.instagram.photos})} · {t(data.instagram.complete?'Inventory complete':'More pages remaining')}</p>}
   <button disabled={running} onClick={runMatching}>{t('Run history-only verification')}</button>
   {matching&&<><p>{t('Historical match status',{confirmed:matching.confirmedCount,proposals:matching.proposalCount})}</p><p className="muted">{t('Historical matches require confirmation before exclusion.')}</p>{matching.pendingCount>0&&<button disabled={confirming} onClick={confirmMatches}>{t('Confirm all visible matches')}</button>}</>}
   <p>{t('History totals',{posts:data.posts,photos:data.photos,unique:data.uniquePhotos})}</p>
   <p className="notice">{t('History coverage warning')}</p>
   <table><thead><tr><th>{t('Date')}</th><th>{t('Photos')}</th><th>Instagram</th></tr></thead>
   <tbody>{data.records.map(r=><tr key={r.draftId}><td>{new Date(r.at).toLocaleString()}</td><td>{r.photos}</td><td>@{r.username} · {r.mediaId}</td></tr>)}</tbody></table>
  </>}
 </section>;
}
