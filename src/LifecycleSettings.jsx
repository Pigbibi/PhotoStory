import {useI18n} from "./i18n.jsx";
import React,{useEffect,useState} from 'react';
export default function LifecycleSettings({api,notify,folder,onStatus}){
  const {t,date,weekday}=useI18n();
  const when=value=>value?date(value):t("等待后台首次检查");
  const [state,setState]=useState(null),[form,setForm]=useState(null),[busy,setBusy]=useState(false);
  const refresh=async restore=>{
    try{const v=await api('/api/settings');setState(v);onStatus(v.backlogPaused);if(restore)setForm({...v.settings,folder:v.settings.folder||folder});}
    catch(e){notify(e.message);}
  };
  useEffect(()=>{refresh(true);const timer=setInterval(()=>refresh(false),15000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{if(folder)setForm(f=>f&&!f.folder?{...f,folder}:f);},[folder,form!==null]);
  if(!form)return <p>{t("正在读取制作与保留规则…")}</p>;
  const set=(k,v)=>setForm(f=>({...f,[k]:v,...(k==='publishMode'&&v==='automatic'?{reviewMode:'strict_auto'}:{}),...(k==='reviewMode'&&v==='manual'?{publishMode:'manual'}:{})}));
  const save=async()=>{
    setBusy(true);
    try{const v=await api('/api/settings','PUT',form);setState(v);onStatus(v.backlogPaused);setForm(v.settings);notify('制作与保留规则已保存。正在进行的批次会先完成。');}
    catch(e){notify(e.message);}
    finally{setBusy(false);}
  };
  const migrate=async()=>{
    setBusy(true);
    try{await api('/api/storage/migrate','POST',{});await refresh(false);notify('图片迁移批次已完成。');}
    catch(e){notify(e.message);}finally{setBusy(false);}
  };
  return <section className="lifecycle">
    <h2>{t("定期制作与保留规则")}</h2>
    {state.storage?.backend==='r2'&&<div className="approval-note">
      <strong>{t('私有图片存储（R2）')}</strong>
      <p>{t('已用 {used} GB / 上限 {limit} GB',{used:(state.storage.usedBytes/1e9).toFixed(3),limit:(state.storage.limitBytes/1e9).toFixed(1)})}</p>
      <p>{t('本月读取 {reads} / {readLimit}；写入 {writes} / {writeLimit}',state.storage)}</p>
      <p className="muted">{t('存储额度说明')}</p>
      {state.storage.warning&&<p role="alert">{t('存储接近上限，请检查容量；不会删除待审核照片。')}</p>}
      {state.storage.legacyPreviews>0&&<button className="button secondary" disabled={busy} onClick={migrate}>{t('迁移现有预览（剩余 {count} 张）',{count:state.storage.legacyPreviews})}</button>}
    </div>}
    <label>{t("审核模式")}<select value={form.reviewMode||'manual'} onChange={e=>set('reviewMode',e.target.value)}><option value="manual">{t("人工批准（默认）")}</option><option value="strict_auto">{t("严格 AI 自动审核")}</option></select></label>
    <p className="muted">{t("严格审核说明")}</p>
    <label>{t("发布模式")}<select value={form.publishMode||'manual'} onChange={e=>set('publishMode',e.target.value)}><option value="manual">{t("人工发布（默认）")}</option><option value="automatic">{t("严格 AI 自动发布")}</option></select></label>
    <p className="muted">{t("自动发布说明")}</p>
    <p className="approval-note">{state.settings.publishMode==='automatic'?t('自动发布已开启'):t('自动发布已关闭')}</p>
    <label className="check"><input type="checkbox" checked={form.enabled} onChange={e=>set('enabled',e.target.checked)}/>{t("定期生成待审核草稿")}</label>
    {form.reviewMode!=="strict_auto" && <p className="muted">{t("只整理照片和文案，不会自动批准或发布。以下是独立的定期制作配置，不会改变上方的手动任务。")}</p>}
    <label>{t("定期制作的照片文件夹")}<input dir="ltr" value={form.folder} maxLength={300} onChange={e=>set('folder',e.target.value)}/></label>
    <div className="date-fields">
      <label>{t("频率")}<select value={form.frequency} onChange={e=>set('frequency',e.target.value)}><option value="weekly">{t("每周")}</option><option value="monthly">{t("每月")}</option></select></label>
      {form.frequency==='weekly'?<label>{t("星期")}<select value={form.weekday} onChange={e=>set('weekday',Number(e.target.value))}>{Array.from({length:7},(_,i)=><option key={i} value={i}>{weekday(i)}</option>)}</select></label>:<label>{t("每月日期")}<input type="number" min={1} max={31} value={form.monthDay} onChange={e=>set('monthDay',Number(e.target.value))}/></label>}
      <label>{t("开始时间")}<select value={form.hour} onChange={e=>set('hour',Number(e.target.value))}>{Array.from({length:24},(_,i)=><option key={i} value={i}>{String(i).padStart(2,'0')}:00</option>)}</select></label>
    </div>
    <p className="muted">{t("时间均为 Asia/Shanghai。短月份会使用当月最后一天；错过多个周期只补一次，不堆积旧任务。")}</p>
    <label>{t("检查照片范围")}<select value={form.range} onChange={e=>set('range',e.target.value)}>{[['1m',t('最近一个月')],['3m',t('最近三个月')],['6m',t('最近六个月')],['12m',t('最近一年')],['all',t('全部照片')],['since',t('From a start date')],['custom',t('自定义日期')]].map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></label>
    {['since','custom'].includes(form.range)&&<label>{t('开始日期')}<input type="date" value={form.start||''} onChange={e=>set('start',e.target.value)}/></label>}
    {form.range==='custom'&&<label>{t('结束日期（包含当天）')}<input type="date" value={form.end||''} onChange={e=>set('end',e.target.value)}/></label>}
    <p className="muted">{t('Photo preselection explanation')}</p>
    <div className="date-fields">
      <label>{t("每次最多分析新照片")}<input type="number" min={1} max={1000} value={form.analysisLimit} onChange={e=>set('analysisLimit',Number(e.target.value))}/></label>
      <label>{t("每批照片")}<select value={form.maxPhotos} onChange={e=>set('maxPhotos',Number(e.target.value))}>{[20,50,100].map(n=><option key={n} value={n}>{t("{count} 张",{count:n})}</option>)}</select></label>
      <label>{t("待审核暂停阈值")}<input type="number" min={1} max={100} value={form.pendingLimit} onChange={e=>set('pendingLimit',Number(e.target.value))}/></label>
    </div>
    <p className="muted">{t("相同版本的已处理照片会跳过。分析额度用完后结束本次制作，剩余照片留到下个周期。达到待审核阈值后暂停所有后续批次，当前批次可能多生成少量草稿；审核后自动继续。")}</p>
    <div className="approval-note">
      <strong>{state.settings.enabled?t('定期制作已开启'):t('定期制作已关闭')}</strong>
      {state.settings.pausedReason==='failed' && <p>{t("上次定期任务失败，已关闭后续制作。请检查原因，修复后再重新启用。")}</p>}
      <p>{t("下次制作：")}{state.settings.enabled?when(state.settings.nextRun):t('未安排')}<br/>{t("上次创建：")}{state.settings.lastRun?when(state.settings.lastRun):t('尚未创建')}<br/>{t("待审核：{count} 篇",{count:state.pending})}{state.backlogPaused?t(' · 已达到暂停阈值'):state.active?t(' · 现有任务先完成'):''}</p>
    </div>
    <label className="check"><input type="checkbox" checked={form.cleanupEnabled} onChange={e=>set('cleanupEnabled',e.target.checked)}/>{t("定期清理过期回收站与临时文件")}</label>
    <p>{t("待审核和已批准的草稿长期保留。回收站保留 30 天；移出草稿的预览也至少保留 30 天，只清理没有草稿引用的图片。OneDrive 原图始终不删除。")}</p>
    <p className="muted">{t("网站每日 04:00 清理过期回收站；VPS 每日 04:20 检查超过 24 小时的临时残留，运行中的任务会跳过。实际执行需后台在线，可能延后。关闭这里不影响正常调用结束后的即时临时清理。")}</p>
    <p className="muted">{t("回收站上次清理：")}{state.cleanup.lastAt?when(state.cleanup.lastAt):t('尚未执行')}<br/>{t("下次检查：")}{state.settings.cleanupEnabled?when(state.cleanup.nextAt):t('已关闭')}<br/>{t("VPS 临时清理：")}{state.temporaryCleanup?when(state.temporaryCleanup.at)+' · '+({ok:t('完成'),busy:t('任务忙碌，已跳过'),error:t('未完成，请检查后台'),disabled:t('已关闭')}[state.temporaryCleanup.status]):t('等待首次报告')}</p>
    <button className="button primary" disabled={busy} onClick={save}>{busy?t('正在保存…'):t('保存制作与保留规则')}</button>
  </section>;
}
