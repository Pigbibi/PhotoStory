import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { reviewDraft } from "../worker/review.mjs";
import "./style.css";
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
  microsoft_not_configured: "尚未配置 Microsoft 应用，请按连接设置完成注册。",
  version_conflict: "草稿已被更新，请刷新后重新审核。",
  save_before_approval: "请先保存修改，再确认批准。",
  job_in_progress: "已有选片任务，请等待它完成。",
  onedrive_not_connected: "请先连接 OneDrive。",
  invalid_dates: "请选择不超过 31 天的有效日期范围。",
  github_not_allowed: "此 GitHub 账号不在管理员允许名单中。",
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
    const error = new URLSearchParams(location.search).get("error");
    if (error) {
      setMessage(errors[error] || "授权未完成，请重新连接。");
      history.replaceState(null, "", location.pathname);
    }
  }, []);
  const startDemo = () => {
    setDemo(true);
    setDrafts([structuredClone(demoDraft)]);
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
      view === "queue" ? d.status === "approved" : d.status === "draft",
    );
  return (
    <>
      <header>
        <a href="/" className="brand">
          Fieldnotes<span>PhotoStory</span>
        </a>
        <nav aria-label="主导航">
          {[
            ["review", "待审核"],
            ["queue", "发布队列"],
            ["settings", "连接设置"],
          ].map(([v, label]) => (
            <button
              key={v}
              className={view === v ? "active" : ""}
              onClick={() => {
                setView(v);
                const ds = drafts.filter((d) =>
                  v === "queue"
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
        <div className="identity">
          {demo ? (
            <button onClick={leaveDemo}>退出演示</button>
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
              {session.user.login} · 退出
            </button>
          ) : (
            <span>私人照片编辑台</span>
          )}
        </div>
      </header>
      <main>
        <section className="intro">
          <h1>
            {view === "settings"
              ? "让故事，从连接开始。"
              : view === "queue"
                ? "准备好，留给下一次分享。"
                : "把旅途，整理成故事。"}
          </h1>
          <p>
            {view === "settings"
              ? "GitHub 登录 · OneDrive 只读 · Codex 选片"
              : view === "queue"
                ? "已批准的草稿 · Instagram 发布尚未启用"
                : "最近一个月 · 风景选片 · 英文文案"}
          </p>
        </section>
        {message && (
          <div className="notice" role="status">
            {message}
            <button aria-label="关闭提示" onClick={() => setMessage("")}>
              关闭
            </button>
          </div>
        )}
        {view === "settings" ? (
          <Settings session={session} notify={setMessage} />
        ) : !session?.user && !demo ? (
          <section className="welcome">
            <img
              src="/demo-coast.png"
              alt="AI 生成的海岸示意图，不是用户照片"
            />
            <div>
              <h2>好照片，值得被看见。</h2>
              <p>
                让 AI 帮你整理主题、挑选风景、写好英文文案。
                <br />
                每一篇，经过你的确认。
              </p>
              <a className="button primary" href="/auth/github/start">
                使用 GitHub 登录
              </a>
              <button className="button secondary" onClick={startDemo}>
                先体验审核流程
              </button>
              <p className="muted">
                示意图片由 AI 生成。真实照片仅登录后可见。
              </p>
              {session && !session.githubConfigured && (
                <p className="setup-hint">
                  首次部署：请在「连接设置」完成 GitHub 应用配置。
                </p>
              )}
            </div>
          </section>
        ) : (
          <div className="workspace">
            <aside>
              <h2>主题草稿</h2>
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
                    {d.title}
                    <small>
                      {d.photos.length} 张 ·{" "}
                      {d.status === "approved" ? "已批准" : "待审核"}
                    </small>
                  </span>
                </button>
              ))}
              {!filtered.length && (
                <p className="muted">
                  {view === "queue"
                    ? "还没有批准的草稿。"
                    : "还没有待审核草稿。连接 OneDrive 后可创建第一批选片任务。"}
                </p>
              )}
              {!demo && (
                <button
                  className="text-button"
                  onClick={() => setView("settings")}
                >
                  管理照片来源
                </button>
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
                  {view === "queue"
                    ? "慢慢挑，喜欢了再分享。"
                    : "从一次旅行开始。"}
                </h2>
                <p>先连接照片来源，再让 Codex 整理一组你愿意分享的故事。</p>
                <button
                  className="button secondary"
                  onClick={() => setView("settings")}
                >
                  打开连接设置
                </button>
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
        >
          开源 · MIT
        </a>
        <span>人工审核优先</span>
      </footer>
    </>
  );
}
function Editor({ draft, demo, busy, update }) {
  const [form, setForm] = useState(structuredClone(draft)),
    [index, setIndex] = useState(0);
  const dirty = JSON.stringify(form) !== JSON.stringify(draft),
    photo = form.photos[index] || form.photos[0];
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
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
      <section className="canvas" aria-label="照片预览">
        <img
          className="main-photo"
          src={demo ? "/demo-coast.png" : "/api/photos/" + photo.id}
          alt={photo.alt}
        />
        <div className="filmstrip">
          {form.photos.map((p, i) => (
            <button
              key={p.id}
              className={i === index ? "selected" : ""}
              onClick={() => setIndex(i)}
              aria-label={"查看第 " + (i + 1) + " 张照片"}
            >
              <img
                src={demo ? "/demo-coast.png" : "/api/photos/" + p.id}
                alt={p.alt}
              />
              <span>
                {i + 1}
                {i === 0 ? " · 封面" : ""}
              </span>
            </button>
          ))}
        </div>
        <div className="photo-tools">
          <button onClick={() => move(-1)} disabled={index === 0}>
            前移
          </button>
          <button
            onClick={() => move(1)}
            disabled={index === form.photos.length - 1}
          >
            后移
          </button>
          <button
            onClick={() => {
              set(
                "photos",
                form.photos.filter((_, i) => i !== index),
              );
              setIndex(0);
            }}
            disabled={form.photos.length === 1}
          >
            移出这篇
          </button>
        </div>
        <p className="muted">
          {demo
            ? "AI 生成的示例照片，尚未连接 OneDrive。"
            : "照片为私有预览。原始文件保留在 OneDrive。"}
        </p>
        <p className="selection-reason">{form.reason}</p>
      </section>
      <section className="editor" aria-label="帖子编辑">
        <label className="title-label">
          主题
          <input
            className="title-input"
            value={form.title}
            maxLength={160}
            onChange={(e) => set("title", e.target.value)}
          />
        </label>
        <p className="muted">主题可编辑 · 英文发布内容</p>
        <hr />
        <label>
          英文文案
          <textarea
            value={form.caption}
            rows={4}
            maxLength={1800}
            onChange={(e) => set("caption", e.target.value)}
          />
        </label>
        <label>
          Hashtags
          <textarea
            value={form.hashtags}
            rows={3}
            maxLength={350}
            onChange={(e) => set("hashtags", e.target.value)}
          />
        </label>
        <div className="approval-note">
          <strong>发布前，请看每一张照片。</strong>
          <p>
            检查人物、私人信息、地点和文案。AI 可能漏判，批准仍需要你的判断。
          </p>
        </div>
        <button
          className="button primary"
          disabled={busy || dirty || draft.status === "approved"}
          onClick={() => update(form, "approve")}
        >
          {draft.status === "approved" ? "草稿已批准" : "批准草稿"}
        </button>
        <button
          className="button secondary"
          disabled={busy || !dirty}
          onClick={() => update(form, "save")}
        >
          保存修改
        </button>
        {draft.status === "approved" && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => update(form, "return")}
          >
            退回待审核
          </button>
        )}
        <p className="muted bottom-note">
          {dirty
            ? "请先保存修改，再批准这个版本。修改已批准的内容会重新进入待审核。"
            : "批准后进入队列，连接 Instagram 后才能发布。"}
        </p>
      </section>
    </>
  );
}
function Settings({ session, notify }) {
  const [folder, setFolder] = useState("手机相册"),
    [start, setStart] = useState(() => dayInShanghai(-30)),
    [end, setEnd] = useState(() => dayInShanghai(1)),
    [jobs, setJobs] = useState([]),
    [busy, setBusy] = useState(false);
  const refresh = async () => {
    try {
      setJobs(await api("/api/jobs"));
    } catch (e) {
      notify(e.message);
    }
  };
  useEffect(() => {
    if (session?.user) refresh();
  }, [session?.user]);
  const createJob = async () => {
    setBusy(true);
    try {
      await api("/api/jobs", "POST", { folder, start, end, maxPhotos: 100 });
      notify("选片任务已排队。后台处理器运行后，草稿会出现在待审核页面。");
      await refresh();
    } catch (e) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  const callback = (path) => location.origin + path;
  return (
    <div className="settings">
      <section>
        <h2>01 / GitHub 登录</h2>
        <p>
          {session?.user
            ? "当前账号：" + session.user.login
            : session?.githubConfigured
              ? "已配置，等待登录。"
              : "尚未配置。为这个新网站单独创建一个 GitHub OAuth App。"}
        </p>
        {!session?.user && (
          <a className="button secondary" href="/auth/github/start">
            使用 GitHub 登录
          </a>
        )}
        <details>
          <summary>部署者配置说明</summary>
          <p>创建 OAuth App，将回调地址设置为：</p>
          <code>{callback("/auth/github/callback")}</code>
          <p>
            在 Cloudflare 的加密 Secret 中配置
            GITHUB_CLIENT_ID、GITHUB_CLIENT_SECRET；ALLOWED_GITHUB_USERS
            仅填写允许登录的 GitHub 用户名。
          </p>
          <a
            href="https://github.com/settings/developers"
            target="_blank"
            rel="noreferrer"
          >
            打开 GitHub 开发者设置
          </a>
        </details>
      </section>
      <section>
        <h2>02 / OneDrive 照片来源</h2>
        <p>
          {session?.onedriveConnected
            ? "已授权连接。按指定文件夹和时间读取照片。"
            : "尚未连接。授权时仅申请读取文件，不修改或删除原图。"}
        </p>
        <a
          className={
            "button secondary " + (!session?.user ? "disabled-link" : "")
          }
          aria-disabled={!session?.user}
          href={session?.user ? "/auth/microsoft/start" : undefined}
        >
          {session?.onedriveConnected ? "重新授权 OneDrive" : "连接 OneDrive"}
        </a>
        <details>
          <summary>首次连接需要配置 Microsoft 应用</summary>
          <p>
            在 Microsoft Entra 应用注册中新建应用，支持个人 Microsoft
            账户，平台选择 Web，回调地址：
          </p>
          <code>{callback("/auth/microsoft/callback")}</code>
          <p>
            配置 MICROSOFT_CLIENT_ID、MICROSOFT_CLIENT_SECRET 和
            TOKEN_ENCRYPTION_KEY 后，再点击连接。应用使用 Files.Read 和
            offline_access；微软权限覆盖可读取文件，PhotoStory
            按选定文件夹限制处理范围。
          </p>
          <a
            href="https://entra.microsoft.com/"
            target="_blank"
            rel="noreferrer"
          >
            打开 Microsoft Entra
          </a>
        </details>
        <label>
          照片文件夹（相对 OneDrive 根目录）
          <input
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="手机相册"
          />
        </label>
        <div className="date-fields">
          <label>
            开始日期
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label>
            结束日期（不包含当天）
            <input
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
        </div>
        <p className="muted">
          按拍摄时间筛选，时区 Asia/Shanghai。首次最多分析 100
          张；超出时整批停止，缩小日期后再试。
        </p>
        <button
          className="button primary"
          disabled={!session?.onedriveConnected || busy}
          onClick={createJob}
        >
          创建选片任务
        </button>
        <p className="muted">
          预览图会发送到你配置的 Codex
          服务进行辨识。不确定或不适合公开的照片不进入草稿。
        </p>
      </section>
      <section>
        <h2>03 / Codex 处理器</h2>
        <p>复用 AIGateway。只用 Codex，不自动切换付费 API 或其他模型服务。</p>
        <p>
          后台处理器尚需在你的 VPS 上配置并启动。任务排队不代表 AI 已经运行。
        </p>
        {session?.user && (
          <>
            <button className="text-button" onClick={refresh}>
              刷新任务状态
            </button>
            <ul className="jobs">
              {jobs.map((j) => (
                <li key={j.id}>
                  {new Date(j.created).toLocaleString("zh-CN")}
                  <strong>
                    {
                      {
                        pending: "等待处理器",
                        running: "处理中",
                        complete: "已完成",
                        failed: "处理失败，未自动重试",
                      }[j.status]
                    }
                  </strong>
                </li>
              ))}
            </ul>
          </>
        )}
        <h2>04 / Instagram</h2>
        <p>
          尚未启用。首版只生成和审核草稿，不会对外发布。后续确认账户与规则后再接入。
        </p>
      </section>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
