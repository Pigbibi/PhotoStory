import {localizedDraftText} from './i18n-core.mjs';
import {I18nProvider,LanguageSwitcher,useI18n} from "./i18n.jsx";
import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { reviewDraft } from "../worker/review.mjs";
import LifecycleSettings from './LifecycleSettings.jsx';
import "./style.css";
import {frameStyle,photoFrame} from "../worker/framing.mjs";
const demoDraft = {
  id: "demo-coast",
  title: "海边的慢时光",
  caption: "Salt in the air, nowhere to rush.",
  hashtags: "#Thailand #CoastalViews #TravelPhotography",
  reason: "用海岸与船作为视觉主题。此图为 AI 生成的界面示例，不是你的照片。",
  photos: [{ id: "demo-coast", alt: "石灰岩海岸与长尾船" }],
  version: 1,
  status: "draft",
};
const dayInShanghai = (offset) =>
  new Date(Date.now() + 8 * 3600000 + offset * 86400000)
    .toISOString()
    .slice(0, 10);
const errors = {
  unauthorized: "请先使用 GitHub 登录。",
  github_not_configured: "尚未配置 GitHub 登录，请按连接设置完成应用注册。",
  instagram_not_configured: "请先配置 Instagram 应用及回调地址。",
  instagram_connection_failed: "授权未完成，请重新连接。",
  microsoft_not_configured: "尚未配置 Microsoft 应用，请按连接设置完成注册。",
  version_conflict: "草稿已被更新，请刷新后重新审核。",
  save_before_approval: "请先保存修改，再确认批准。",
  job_in_progress: "已有选片任务，请等待它完成。",
  onedrive_not_connected: "请先连接 OneDrive。",
  invalid_dates: "请选择有效日期，结束日期不能早于开始日期。",
  invalid_range: "请选择有效的照片范围。",
  invalid_settings: "请检查制作规则中的文件夹、时间和数量范围。",
  invalid_batch_size: "每批照片数量需在 1 到 100 之间。",
  github_not_allowed: "此 GitHub 账号不在管理员允许名单中。",
  invalid_framing: "请选择有效的尺寸和裁剪位置。",
  invalid_language: "AI 文案语言配置无效，请检查 AI_CAPTION_LANGUAGE。",
  request_failed: "操作没有完成。请检查连接状态；未自动重试。",
};
async function api(path, method = "GET", body) {
  const r = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok)
    throw new Error(errors[data.error] || "操作未完成，请检查设置后重试。");
  return data;
}
function App() {
  const {t,locale}=useI18n();
  const [session, setSession] = useState(null),
    [view, setView] = useState("review"),
    [demo, setDemo] = useState(false),
    [drafts, setDrafts] = useState([]),
    [selected, setSelected] = useState(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      const s = await api("/api/session");
      setSession(s);
      if (s.user) {
        const ds = await api("/api/drafts");
        setDrafts(ds);
        setSelected((prev) =>
          ds.some((d) => d.id === prev) ? prev : ds[0]?.id,
        );
      }
    } catch {
      setMessage("暂时无法连接网站服务。");
    }
  };
  useEffect(() => {
    load();
    const params=new URLSearchParams(location.search);
    const error = params.get("error");
    if(params.get("instagram")==="connected"||error?.startsWith("instagram_")){setView("settings");history.replaceState(null,"",location.pathname);}
    if (error) {
      setMessage(errors[error] || t("授权未完成，请重新连接。"));
      history.replaceState(null, "", location.pathname);
    }
  }, []);
  const startDemo = () => {
    setDemo(true);
    setDrafts([{...structuredClone(demoDraft),title:t(demoDraft.title),reason:t(demoDraft.reason),photos:demoDraft.photos.map(p=>({...p,alt:t(p.alt)}))}]);
    setSelected(demoDraft.id);
    setView("review");
    setMessage("演示修改仅保留在当前页面，不会保存或发布真实内容。");
  };
  const leaveDemo = () => {
    setDemo(false);
    setDrafts([]);
    setSelected(null);
    setMessage("");
    load();
  };
  const update = async (d, action) => {
    setBusy(true);
    try {
      const next = demo
        ? reviewDraft(
            drafts.find((x) => x.id === d.id),
            { ...d, action },
          )
        : await api("/api/drafts/" + d.id, "PATCH", { ...d, action });
      setDrafts((ds) => ds.map((x) => (x.id === next.id ? next : x)));
      setMessage(
        action === "approve"
          ? "已批准，保留在发布队列中。当前尚未启用发布。"
          : action === 'trash' ? '已移入回收站，保留 30 天，可恢复到待审核。'
          : action === 'restore' ? '已恢复到待审核，需要重新确认后才能批准。'
          : action === "return"
            ? "已退回待审核。"
            : "修改已保存。",
      );
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  };
  const current = drafts.find((d) => d.id === selected),
    filtered = drafts.filter((d) =>
      view === 'trash'?d.status==='trash':view === "queue" ? d.status === "approved" : d.status === "draft",
    );
  return (
    <>
      <header>
        <a href="/" className="brand">
          Fieldnotes<span>PhotoStory</span>
        </a>
        <nav aria-label={t("主导航")}>
          {[
            ["review", t("待审核")],
            ["queue", t("发布队列")],
            ['trash',t('回收站')],
            ["settings", t("连接设置")],
          ].map(([v, label]) => (
            <button
              key={v}
              className={view === v ? "active" : ""}
              onClick={() => {
                setView(v);
                if (v !== "settings" && session?.user && !demo) load();
                const ds = drafts.filter((d) =>
                  v === 'trash'?d.status==='trash':v === "queue"
                    ? d.status === "approved"
                    : d.status === "draft",
                );
                if (!ds.some((d) => d.id === selected)) setSelected(ds[0]?.id);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <LanguageSwitcher />
        <div className="identity">
          {demo ? (
            <button onClick={leaveDemo}>{t("退出演示")}</button>
          ) : session?.user ? (
            <button
              onClick={async () => {
                try {
                  await api("/auth/logout", "POST");
                  setSession(null);
                  setDrafts([]);
                  location.reload();
                } catch (e) {
                  setMessage(e.message);
                }
              }}
            >
              {t("{user} · 退出",{user:session.user.login})}
            </button>
          ) : (
            <span>{t("私人照片编辑台")}</span>
          )}
        </div>
      </header>
      <main>
        <section className="intro">
          <h1>
            {view === "settings"
              ? t("让故事，从连接开始。")
              :view==='trash'?t('不着急，留三十天再决定。')
              : view === "queue"
                ? t("准备好，留给下一次分享。")
                : t("把旅途，整理成故事。")}
          </h1>
          <p>
            {view === "settings"
              ? t("GitHub 登录 · OneDrive 只读 · Codex 选片")
              :view==='trash'?t('恢复后重新审核 · 到期仅清理本站预览 · OneDrive 原图保留')
              : view === "queue"
                ? t("已批准的草稿 · Instagram 发布尚未启用")
                : t("按时间与地点整理 · 风景选片 · 文案")}
          </p>
        </section>
        {message && (
          <div className="notice" role="status">
            {t(message)}
            <button aria-label={t("关闭提示")} onClick={() => setMessage("")}>{t("关闭")}</button>
          </div>
        )}
        {view === "settings" ? (
          <Settings session={session} notify={setMessage} />
        ) : !session?.user && !demo ? (
          <section className="welcome">
            <img
              src="/demo-coast.png"
              alt={t("AI 生成的海岸示意图，不是用户照片")}
            />
            <div>
              <h2>{t("好照片，值得被看见。")}</h2>
              <p>{t("让 AI 帮你整理主题、挑选风景、写好文案。")}<br />{t("每一篇，经过你的确认。")}</p>
              <a className="button primary" href="/auth/github/start">{t("使用 GitHub 登录")}</a>
              <button className="button secondary" onClick={startDemo}>{t("先体验审核流程")}</button>
              <p className="muted">{t("示意图片由 AI 生成。真实照片仅登录后可见。")}</p>
              {session && !session.githubConfigured && (
                <p className="setup-hint">{t("首次部署：请在「连接设置」完成 GitHub 应用配置。")}</p>
              )}
            </div>
          </section>
        ) : (
          <div className="workspace">
            <aside>
              <h2>{t("主题草稿")}</h2>
              {filtered.map((d) => (
                <button
                  key={d.id}
                  className={
                    "draft-row " + (d.id === selected ? "selected" : "")
                  }
                  onClick={() => setSelected(d.id)}
                >
                  <img
                    src={
                      demo ? "/demo-coast.png" : "/api/photos/" + d.photos[0].id
                    }
                    alt=""
                  />
                  <span>
                    {localizedDraftText(d,'title',locale)}
                    <small>
                      {t("{count} 张",{count:d.photos.length})}{" · "}
                      {d.status === 'trash'?t('回收站'):d.status === "approved" ? t("已批准") : t("待审核")}
                    </small>
                  </span>
                </button>
              ))}
              {!filtered.length && (
                <p className="muted">
                  {view === 'trash'?t('回收站是空的。'):view === "queue"
                    ? t("还没有批准的草稿。")
                    : t("还没有待审核草稿。连接 OneDrive 后可创建第一批选片任务。")}
                </p>
              )}
              {!demo && (
                <button
                  className="text-button"
                  onClick={() => setView("settings")}
                >{t("管理照片来源")}</button>
              )}
            </aside>
            {current && filtered.some((d) => d.id === current.id) ? (
              <Editor
                key={current.id + ":" + current.version}
                draft={current}
                demo={demo}
                busy={busy}
                update={update}
              />
            ) : (
              <div className="empty">
                <h2>
                  {view==='trash'?t('回收站里没有草稿。'):view === "queue"
                    ? t("慢慢挑，喜欢了再分享。")
                    : t("从一次旅行开始。")}
                </h2>
                <p>{view==='trash'?t('不采用的草稿会在这里保留 30 天，期间可以恢复。'):t('先连接照片来源，再让 Codex 整理一组你愿意分享的故事。')}</p>
                {view!=='trash' && <button
                  className="button secondary"
                  onClick={() => setView("settings")}
                >{t("打开连接设置")}</button>}
              </div>
            )}
          </div>
        )}
      </main>
      <footer>
        <span>PhotoStory · by Pigbibi</span>
        <a
          href="https://github.com/Pigbibi/PhotoStory"
          target="_blank"
          rel="noreferrer"
        >{t("开源 · MIT")}</a>
        <span>{t("人工审核优先")}</span>
      </footer>
    </>
  );
}
function Editor({ draft, demo, busy, update }) {
  const {t,date,locale}=useI18n();
  const [form, setForm] = useState(structuredClone(draft)),
    [index, setIndex] = useState(0),
    [exporting,setExporting]=useState(false),[exportProgress,setExportProgress]=useState(''),[exportError,setExportError]=useState(false);
  const download=async()=>{
    setExporting(true);setExportError(false);setExportProgress('');
    try{const {exportDraft}=await import('./export.mjs');await exportDraft(draft,(done,total)=>setExportProgress(`${done}/${total}`));}
    catch(err){setExportError(true);console.warn('PhotoStory export: '+(['source_unavailable','source_changed','original_format','original_too_large','original_too_small','approval_required','version_conflict','reauthorization_required'].includes(err?.message)?err.message:'export_failed'));}
    finally{setExporting(false);}
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(draft),
    photo = form.photos[index] || form.photos[0];
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setFrame = patch => set("photos",form.photos.map(p=>p.id===photo.id?{...p,frame:{...photoFrame(p.frame),...patch}}:p));
  const move = (delta) => {
    const dest = index + delta;
    if (dest < 0 || dest >= form.photos.length) return;
    const photos = [...form.photos];
    [photos[index], photos[dest]] = [photos[dest], photos[index]];
    set("photos", photos);
    setIndex(dest);
  };
  return (
    <>
      <section className="canvas" aria-label={t("照片预览")}>
        <img
          className="main-photo"
          style={frameStyle(form.aspect,photo.frame)}
          src={demo ? "/demo-coast.png" : "/api/photos/" + photo.id}
          alt={photo.alt}
        />
        <div className="filmstrip">
          {form.photos.map((p, i) => (
            <button
              key={p.id}
              className={i === index ? "selected" : ""}
              onClick={() => setIndex(i)}
              aria-label={t("查看第 {count} 张照片",{count:i+1})}
            >
              <img
                src={demo ? "/demo-coast.png" : "/api/photos/" + p.id}
                alt={p.alt}
                style={frameStyle(form.aspect,p.frame)}
              />
              <span>
                {i + 1}
                {i === 0 ? t(" · 封面") : ""}
              </span>
            </button>
          ))}
        </div>
        <fieldset className="framing" disabled={draft.status==='trash'||busy}>
          <legend>{t("整组构图")}</legend>
          <div className="date-fields">
            <label>{t("统一尺寸")}<select value={form.aspect||'4:5'} onChange={e=>set('aspect',e.target.value)}>
              <option value="4:5">{t("4:5 竖版")}</option><option value="1:1">{t("1:1 方形")}</option><option value="3:2">{t("3:2 横版")}</option>
            </select></label>
            <label>{t("当前照片")}<select value={photoFrame(photo.frame).mode} onChange={e=>setFrame({mode:e.target.value})}>
              <option value="fit">{t("完整保留 · 白色留边")}</option><option value="crop">{t("裁剪填满")}</option>
            </select></label>
          </div>
          {photoFrame(photo.frame).mode==='crop' && <div className="date-fields">
            <label>{t("水平位置")}<input dir="ltr" type="range" min="0" max="100" value={photoFrame(photo.frame).x} onChange={e=>setFrame({x:Number(e.target.value)})}/></label>
            <label>{t("垂直位置")}<input dir="ltr" type="range" min="0" max="100" value={photoFrame(photo.frame).y} onChange={e=>setFrame({y:Number(e.target.value)})}/></label>
          </div>}
          <p className="muted">{t("同一篇使用统一画布。逐张检查裁剪后的主体；留边模式保留完整画面。这里只保存构图参数和预览，正式发布图仍需从 OneDrive 原图生成。")}</p>
        </fieldset>
        {draft.status!=='trash' && <div className="photo-tools">
          <button onClick={() => move(-1)} disabled={index === 0}>{t("前移")}</button>
          <button
            onClick={() => move(1)}
            disabled={index === form.photos.length - 1}
          >{t("后移")}</button>
          <button
            onClick={() => {
              set(
                "photos",
                form.photos.filter((_, i) => i !== index),
              );
              setIndex(0);
            }}
            disabled={form.photos.length === 1}
          >{t("移出这篇")}</button>
        </div>}
        <p className="muted">
          {demo
            ? t("AI 生成的示例照片，尚未连接 OneDrive。")
            : t("照片为私有预览。原始文件保留在 OneDrive。")}
        </p>
        <p className="selection-reason">{localizedDraftText(form,'reason',locale)}</p>
      </section>
      <section className="editor" aria-label={t("帖子编辑")}>
        <label className="title-label">{t("主题")}<input
            className="title-input"
            dir="auto"
            readOnly={draft.status==='trash'}
            value={localizedDraftText(form,'title',locale)}
            maxLength={160}
            onChange={(e) => setForm(f=>({...f,title:e.target.value,translations:undefined}))}
          />
        </label>
        {draft.status==='approved' && draft.approvalSource==='strict_ai_v1' && <p className="muted">{t("由严格 AI 自动审核批准")}</p>}
        <p className="muted">{t("主题可编辑 · 发布内容")}</p>
        <hr />
        <label>{t("文案")}<textarea dir="auto"
            value={form.caption}
            readOnly={draft.status==='trash'}
            rows={4}
            maxLength={1800}
            onChange={(e) => set("caption", e.target.value)}
          />
        </label>
        <label>
          Hashtags
          <textarea dir="auto"
            value={form.hashtags}
            readOnly={draft.status==='trash'}
            rows={3}
            maxLength={350}
            onChange={(e) => set("hashtags", e.target.value)}
          />
        </label>
        {draft.status==='trash'?<>
          <p>{t("保留至 {date}，之后在启用清理时移除。",{date:date(draft.trashedAt+30*86400000)})}</p>
          <button className="button primary" disabled={busy} onClick={()=>update(draft,'restore')}>{t("恢复到待审核")}</button>
        </>:<><div className="approval-note">
          <strong>{t("发布前，请看每一张照片。")}</strong>
          <p>{t("检查人物、私人信息、地点和文案。AI 可能漏判，批准仍需要你的判断。")}</p>
        </div>
        <button
          className="button primary"
          disabled={busy || dirty || draft.status === "approved"}
          onClick={() => update(form, "approve")}
        >
          {draft.status === "approved" ? t("草稿已批准") : t("批准草稿")}
        </button>
        <button
          className="button secondary"
          disabled={busy || !dirty}
          onClick={() => update(form, "save")}
        >{t("保存修改")}</button>
        <button className="button secondary" disabled={demo||busy||dirty||exporting||draft.status!=='approved'} onClick={download}>{exporting?t('正在生成…')+' '+exportProgress:t('下载成品 ZIP')}</button>
        <p className="muted">{t('从已批准原图生成统一 1080px 宽 JPEG，不保留 GPS；同时附上文案。')}</p>
        {exportError&&<p role="alert">{t('导出失败：请确认批准和原图版本；仅支持 JPEG/PNG，单张最多 25 MB，且清晰度足够。')}</p>}
        {draft.status === "approved" && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => update(form, "return")}
          >{t("退回待审核")}</button>
        )}
        <p className="muted bottom-note">
          {dirty
            ? t("请先保存修改，再批准这个版本。修改已批准的内容会重新进入待审核。")
            : t("批准后进入队列，连接 Instagram 后才能发布。")}
        </p>
        <button className="text-button" disabled={busy||dirty} onClick={()=>update(draft,'trash')}>{t("不采用，移入回收站")}</button>
        </>}
      </section>
    </>
  );
}
function Settings({ session, notify }) {
  const {t,locale,date}=useI18n();
  const [folder, setFolder] = useState(""),
    [range,setRange] = useState("1m"),
    [start, setStart] = useState(() => dayInShanghai(-30)),
    [end, setEnd] = useState(() => dayInShanghai(0)),
    [maxPhotos,setMaxPhotos] = useState(50),
    [locationHint,setLocationHint] = useState(""),
    [jobs, setJobs] = useState([]),
    [backlogPaused,setBacklogPaused]=useState(false),
    [busy, setBusy] = useState(false);
  const refresh = async (restore=false) => {
    try {
      const rows=await api("/api/jobs");
      setJobs(rows);
      if(restore && rows[0]) {
        const last=rows[0];
        setFolder(last.folder||"");
        setRange(last.selection?.range||"1m");
        if(last.selection?.start) setStart(last.selection.start);
        if(last.selection?.end) setEnd(last.selection.end);
        setMaxPhotos(Math.min(100,last.maxPhotos||50));
        setLocationHint(last.locationHint||"");
      }
    } catch (e) { notify(e.message); }
  };
  useEffect(() => {
    if (!session?.user) return;
    refresh(true);
    const timer=setInterval(()=>refresh(),15000);
    return ()=>clearInterval(timer);
  }, [session?.user?.login]);
  const createJob = async () => {
    setBusy(true);
    try {
      await api("/api/jobs", "POST", { folder, range, start, end, maxPhotos, locationHint });
      notify("任务已排队。处理器会先扫描所选范围，再自动分批整理草稿。");
      await refresh();
    } catch (e) { notify(e.message); }
    finally { setBusy(false); }
  };
  const stopJob=async id=>{
    try { await api(`/api/jobs/${id}/stop`,"POST",{}); await refresh(); }
    catch(e) { notify(e.message); }
  };
  const callback = (path) => location.origin + path;
  return (
    <div className="settings">
      <section>
        <h2>{t("01 / GitHub 登录")}</h2>
        <p>
          {session?.user
            ? t("当前账号：{user}",{user:session.user.login})
            : session?.githubConfigured
              ? t("已配置，等待登录。")
              : t("尚未配置。为这个新网站单独创建一个 GitHub OAuth App。")}
        </p>
        {!session?.user && (
          <a className="button secondary" href="/auth/github/start">{t("使用 GitHub 登录")}</a>
        )}
        <details>
          <summary>{t("部署者配置说明")}</summary>
          <p>{t("创建 OAuth App，将回调地址设置为：")}</p>
          <code>{callback("/auth/github/callback")}</code>
          <p>{t("在 Cloudflare 的加密 Secret 中配置 GITHUB_CLIENT_ID、GITHUB_CLIENT_SECRET；ALLOWED_GITHUB_USERS 仅填写允许登录的 GitHub 用户名。")}</p>
          <a
            href="https://github.com/settings/developers"
            target="_blank"
            rel="noreferrer"
          >{t("打开 GitHub 开发者设置")}</a>
        </details>
      </section>
      <section>
        <h2>{t("02 / OneDrive 照片来源")}</h2>
        <p>
          {session?.onedriveConnected
            ? t("已授权连接。按指定文件夹和时间读取照片。")
            : t("尚未连接。授权时仅申请读取文件，不修改或删除原图。")}
        </p>
        <a
          className={
            "button secondary " + (!session?.user ? "disabled-link" : "")
          }
          aria-disabled={!session?.user}
          href={session?.user ? "/auth/microsoft/start" : undefined}
        >
          {session?.onedriveConnected ? t("重新授权 OneDrive") : t("连接 OneDrive")}
        </a>
        <details>
          <summary>{t("首次连接需要配置 Microsoft 应用")}</summary>
          <p>{t("在 Microsoft Entra 应用注册中新建应用，支持个人 Microsoft 账户，平台选择 Web，回调地址：")}</p>
          <code>{callback("/auth/microsoft/callback")}</code>
          <p>{t("配置 MICROSOFT_CLIENT_ID、MICROSOFT_CLIENT_SECRET 和 TOKEN_ENCRYPTION_KEY 后，再点击连接。应用使用 Files.Read 和 offline_access；微软权限覆盖可读取文件，PhotoStory 按选定文件夹限制处理范围。")}</p>
          <a
            href="https://entra.microsoft.com/"
            target="_blank"
            rel="noreferrer"
          >{t("打开 Microsoft Entra")}</a>
        </details>
        <label>{t("照片文件夹（相对 OneDrive 根目录）")}<input dir="ltr"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder={t("例如：Pictures/Camera Roll")}
          />
        </label>
        <label>{t("照片范围")}<select value={range} onChange={e=>setRange(e.target.value)}>
            <option value="1m">{t("最近一个月")}</option>
            <option value="3m">{t("最近三个月")}</option>
            <option value="6m">{t("最近六个月")}</option>
            <option value="12m">{t("最近一年")}</option>
            <option value="all">{t("全部照片")}</option>
            <option value="custom">{t("自定义日期")}</option>
          </select>
        </label>
        {range==="custom" && (
        <div className="date-fields">
          <label>{t("开始日期")}<input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label>{t("结束日期（包含当天）")}<input
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
        </div>)}
        <div className="date-fields">
          <label>{t("每批最多分析")}<select value={maxPhotos} onChange={e=>setMaxPhotos(Number(e.target.value))}>
              <option value={20}>{t("20 张")}</option><option value={50}>{t("50 张")}</option><option value={100}>{t("100 张")}</option>
            </select>
          </label>
          <label>{t("地点备注（可选）")}<input value={locationHint} maxLength={160} onChange={e=>setLocationHint(e.target.value)} placeholder={t("国家或地区；留空则按画面描述")} />
          </label>
        </div>
        <p className="muted">{t("按拍摄时间筛选，时区 Asia/Shanghai。先扫描整个范围，再自动分批分析；照片多不会整批失败。 以连续拍摄时间、可用的粗略地点和画面主题分组，没有可靠地点时不会编造地名。 已处理的相同版本照片会复用记录；无拍摄时间的文件会跳过。")}</p>
        {range==="all" && <p className="approval-note">{t("“全部”会持续分批处理这个文件夹内的合格照片，可能消耗较多 Codex 额度。可在任务列表停止后续批次。")}</p>}
        <button
          className="button primary"
          disabled={!session?.onedriveConnected || busy || !folder.trim() || jobs.some(j=>["pending","running"].includes(j.status))}
          onClick={createJob}
        >{t("创建选片任务")}</button>
        <p className="muted">{t("预览图会发送到你配置的 Codex 服务进行辨识。不确定或不适合公开的照片不进入草稿。")}</p>
      </section>
      <section>
        <h2>{t("03 / Codex 处理器")}</h2>
        <p>{t("AI 文案语言：{language}。更改网站语言不会改写草稿。",{language:session?.captionLanguage||"en"})}</p>
        <p>{t("选择适合你的部署方式。两种模式都只用 Codex，不自动切换付费 API。")}</p>
        <details>
          <summary>{t("从零部署：Codex CLI 模式")}</summary>
          <p>{t("在独立 Linux VPS 上安装 Codex CLI 并登录已有账号，即可选片和生成文案，无需 AIGateway。")}</p>
        </details>
        <details>
          <summary>{t("已有服务：AIGateway 模式")}</summary>
          <p>{t("接入你已部署的兼容 AIGateway，复用其 Codex 能力。登录是否需要另行配置，取决于现有服务的运行账户和凭据管理。")}</p>
        </details>
        <p><a href={locale.startsWith("zh")?"https://github.com/Pigbibi/PhotoStory/blob/main/docs/ai-setup.zh-CN.md":"https://github.com/Pigbibi/PhotoStory/blob/main/README.md#ai-caption-language"} target="_blank" rel="noreferrer">{t("查看 AI 配置教程、密钥和权限说明 ↗")}</a></p>
        <p>{t("运行模式在 VPS 上配置；本页的教程不会切换后台配置。任务排队不代表 AI 已经运行。")}</p>
        {session?.user && (
          <>
            <button className="text-button" onClick={()=>refresh()}>{t("刷新任务状态")}</button>
            <ul className="jobs">
              {jobs.map((j) => (
                <li key={j.id}>
                  {date(j.created)}
                  <strong>
                    {
                      {
                        pending: t("等待处理器"),
                        running: t("处理中"),
                        complete: t("已完成"),
                        failed: t("处理失败，未自动重试"),
                        cancelled: t("已停止后续批次"),
                        limited: t("已达到本次分析上限，剩余照片留到下个周期"),
                      }[j.status]
                    }
                  </strong>
                  {j.progress && <p className="job-progress">
                    {j.progress.phase==="scanning" ? t("正在扫描 · 已发现 {count} 张候选",{count:j.progress.total}) : t("已处理 {done} / {total} 张 · {batches} 批",{done:j.progress.processed,total:j.progress.total,batches:j.progress.batches})}
                    {j.analysisLimit && t(" · 本次分析 {done} / {total} 张",{done:j.progress.analyzed||0,total:j.analysisLimit})}
                    {j.status==='pending' && backlogPaused && t(' · 待审核已达阈值，暂停后续批次')}
                  </p>}
                  {["pending","running"].includes(j.status) && (
                    <button className="text-button" disabled={j.stopRequested} onClick={()=>stopJob(j.id)}>
                      {j.stopRequested ? t("本批结束后停止") : t("停止后续批次")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        <h2>04 / Instagram</h2>
        <p>{t("Instagram 账号连接不会发布照片。")}</p>
        {session?.user && <>
          {session.instagram?.connected && <p>{t("已连接：@{username}",{username:session.instagram.username})}</p>}
          {session.instagram?.expires && <p>{t("授权有效期至 {date}。",{date:date(session.instagram.expires)})}</p>}
          {session.instagram?.configured
            ? <a className="button secondary" href="/auth/instagram/start">{t(session.instagram.username ? "重新连接 Instagram" : "连接 Instagram")}</a>
            : <p>{t("请先配置 Instagram 应用及回调地址。")}</p>}
        </>}
        <p><a href={locale.startsWith('zh') ? "https://github.com/Pigbibi/PhotoStory/blob/main/docs/instagram-setup.zh-CN.md" : "https://github.com/Pigbibi/PhotoStory/blob/main/docs/instagram-setup.md"} target="_blank" rel="noreferrer">{t("Instagram 配置教程")}</a></p>
      </section>
      {session?.user && <LifecycleSettings api={api} notify={notify} folder={folder} onStatus={setBacklogPaused}/>}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<I18nProvider><App /></I18nProvider>);
