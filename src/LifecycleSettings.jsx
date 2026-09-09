import React,{useEffect,useState} from 'react';
const when=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'等待后台首次检查';
export default function LifecycleSettings({api,notify,folder,onStatus}){
  const [state,setState]=useState(null),[form,setForm]=useState(null),[busy,setBusy]=useState(false);
  const refresh=async restore=>{
    try{const v=await api('/api/settings');setState(v);onStatus(v.backlogPaused);if(restore)setForm({...v.settings,folder:v.settings.folder||folder});}
    catch(e){notify(e.message);}
  };
  useEffect(()=>{refresh(true);const timer=setInterval(()=>refresh(false),15000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{if(folder)setForm(f=>f&&!f.folder?{...f,folder}:f);},[folder]);
  if(!form)return <p>正在读取制作与保留规则…</p>;
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const save=async()=>{
    setBusy(true);
    try{const v=await api('/api/settings','PUT',form);setState(v);onStatus(v.backlogPaused);setForm(v.settings);notify('制作与保留规则已保存。正在进行的批次会先完成。');}
    catch(e){notify(e.message);}
    finally{setBusy(false);}
  };
  return <section className="lifecycle">
    <h2>定期制作与保留规则</h2>
    <label className="check"><input type="checkbox" checked={form.enabled} onChange={e=>set('enabled',e.target.checked)}/>定期生成待审核草稿</label>
    <p className="muted">只整理照片和英文文案，不会自动批准或发布。以下是独立的定期制作配置，不会改变上方的手动任务。</p>
    <label>定期制作的照片文件夹<input value={form.folder} maxLength={300} onChange={e=>set('folder',e.target.value)}/></label>
    <div className="date-fields">
      <label>频率<select value={form.frequency} onChange={e=>set('frequency',e.target.value)}><option value="weekly">每周</option><option value="monthly">每月</option></select></label>
      {form.frequency==='weekly'?<label>星期<select value={form.weekday} onChange={e=>set('weekday',Number(e.target.value))}>{['日','一','二','三','四','五','六'].map((v,i)=><option key={i} value={i}>星期{v}</option>)}</select></label>:<label>每月日期<input type="number" min={1} max={31} value={form.monthDay} onChange={e=>set('monthDay',Number(e.target.value))}/></label>}
      <label>开始时间<select value={form.hour} onChange={e=>set('hour',Number(e.target.value))}>{Array.from({length:24},(_,i)=><option key={i} value={i}>{String(i).padStart(2,'0')}:00</option>)}</select></label>
    </div>
    <p className="muted">时间均为 Asia/Shanghai。短月份会使用当月最后一天；错过多个周期只补一次，不堆积旧任务。</p>
    <label>检查照片范围<select value={form.range} onChange={e=>set('range',e.target.value)}>{[['1m','最近一个月'],['3m','最近三个月'],['6m','最近六个月'],['12m','最近一年'],['all','全部照片']].map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></label>
    <div className="date-fields">
      <label>每次最多分析新照片<input type="number" min={1} max={1000} value={form.analysisLimit} onChange={e=>set('analysisLimit',Number(e.target.value))}/></label>
      <label>每批照片<select value={form.maxPhotos} onChange={e=>set('maxPhotos',Number(e.target.value))}>{[20,50,100].map(n=><option key={n} value={n}>{n} 张</option>)}</select></label>
      <label>待审核暂停阈值<input type="number" min={1} max={100} value={form.pendingLimit} onChange={e=>set('pendingLimit',Number(e.target.value))}/></label>
    </div>
    <p className="muted">相同版本的已处理照片会跳过。分析额度用完后结束本次制作，剩余照片留到下个周期。达到待审核阈值后暂停所有后续批次，当前批次可能多生成少量草稿；审核后自动继续。</p>
    <div className="approval-note">
      <strong>{state.settings.enabled?'定期制作已开启':'定期制作已关闭'}</strong>
      {state.settings.pausedReason==='failed' && <p>上次定期任务失败，已关闭后续制作。请检查原因，修复后再重新启用。</p>}
      <p>下次制作：{state.settings.enabled?when(state.settings.nextRun):'未安排'}<br/>上次创建：{state.settings.lastRun?when(state.settings.lastRun):'尚未创建'}<br/>待审核：{state.pending} 篇{state.backlogPaused?' · 已达到暂停阈值':state.active?' · 现有任务先完成':''}</p>
    </div>
    <label className="check"><input type="checkbox" checked={form.cleanupEnabled} onChange={e=>set('cleanupEnabled',e.target.checked)}/>定期清理过期回收站与临时文件</label>
    <p>待审核和已批准的草稿长期保留。回收站保留 30 天；移出草稿的预览也至少保留 30 天，只清理没有草稿引用的图片。OneDrive 原图始终不删除。</p>
    <p className="muted">网站每日 04:00 清理过期回收站；VPS 每日 04:20 检查超过 24 小时的临时残留，运行中的任务会跳过。实际执行需后台在线，可能延后。关闭这里不影响正常调用结束后的即时临时清理。</p>
    <p className="muted">回收站上次清理：{state.cleanup.lastAt?when(state.cleanup.lastAt):'尚未执行'}<br/>下次检查：{state.settings.cleanupEnabled?when(state.cleanup.nextAt):'已关闭'}<br/>VPS 临时清理：{state.temporaryCleanup?`${when(state.temporaryCleanup.at)} · ${{ok:'完成',busy:'任务忙碌，已跳过',error:'未完成，请检查后台',disabled:'已关闭'}[state.temporaryCleanup.status]}`:'等待首次报告'}</p>
    <button className="button primary" disabled={busy} onClick={save}>{busy?'正在保存…':'保存制作与保留规则'}</button>
  </section>;
}
