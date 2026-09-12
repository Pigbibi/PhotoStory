export const cookieName = "__Host-photostory";
export const random = () => crypto.randomUUID() + crypto.randomUUID();
export const cookie = (name, value, age) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
export const cookies = (r) =>
  Object.fromEntries(
    (r.headers.get("Cookie") || "").split(";").map((v) => v.trim().split("=")),
  );
export const configured = (e) =>
  Boolean(
    e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET && e.ALLOWED_GITHUB_USERS,
  );
export async function hash(s) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export async function put(e, key, value, expires = null) {
  // D1 has no automatic TTL: retire expired auth records without touching tokens.
  if (expires !== null)
    await e.DB.prepare(
      "DELETE FROM state WHERE key IN (SELECT key FROM state WHERE expires <= ? ORDER BY expires LIMIT 256)",
    ).bind(Date.now()).run();
  await e.DB.prepare(
    "INSERT INTO state(key,value,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=excluded.expires",
  )
    .bind(key, JSON.stringify(value), expires)
    .run();
}
export async function get(e, key) {
  const r = await e.DB.prepare("SELECT value,expires FROM state WHERE key=?")
    .bind(key)
    .first();
  return r && (!r.expires || r.expires > Date.now())
    ? JSON.parse(r.value)
    : null;
}
export async function remove(e, key) {
  await e.DB.prepare("DELETE FROM state WHERE key=?").bind(key).run();
}
export function allowed(e, login) {
  return String(e.ALLOWED_GITHUB_USERS || "")
    .toLowerCase()
    .split(",")
    .map((x) => x.trim())
    .includes(String(login).toLowerCase());
}
export async function session(r, e) {
  const token = cookies(r)[cookieName];
  if (!token || !e.DB) return null;
  const s = await get(e, "session:" + (await hash(token)));
  return s && allowed(e, s.login) ? s : null;
}
export function redirect(location, values = []) {
  const h = new Headers({ Location: location });
  for (const v of values) h.append("Set-Cookie", v);
  return new Response(null, { status: 302, headers: h });
}
export async function fetchJSON(url, options) {
  const r = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error("provider_unavailable");
  return r.json();
}
async function challenge(verifier) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
// Session cookies and one-use OAuth state follow the invoice portal's server-side pattern.
async function limitStart(e) {
  // A fixed key bounds anonymous writes even when callers rotate arbitrary inputs.
  if (!e.AUTH_LIMITER)
    return new Response("Login protection is not configured.", { status: 503 });
  const { success } = await e.AUTH_LIMITER.limit({ key: "photostory:oauth-start" });
  return success ? null : new Response("Please retry login in a minute.", {
    status: 429, headers: { "Retry-After": "60" },
  });
}
export async function githubStart(r, e) {
  if (!configured(e) || !e.DB) return redirect("/?error=github_not_configured");
  const limited = await limitStart(e);
  if (limited) return limited;
  const state = random(),
    verifier = random();
  await put(
    e,
    "oauth:" + (await hash(state)),
    { verifier },
    Date.now() + 600000,
  );
  const u = new URL("https://github.com/login/oauth/authorize");
  u.search = new URLSearchParams({
    client_id: e.GITHUB_CLIENT_ID,
    redirect_uri: new URL("/auth/github/callback", r.url).href,
    state,
    code_challenge: await challenge(verifier),
    code_challenge_method: "S256",
  });
  return redirect(u.href, [cookie("__Host-ps-oauth", state, 600)]);
}
export async function githubFinish(r, e) {
  const u = new URL(r.url),
    state = u.searchParams.get("state"),
    code = u.searchParams.get("code");
  if (
    !configured(e) ||
    !state ||
    !code ||
    cookies(r)["__Host-ps-oauth"] !== state
  )
    throw new Error("invalid_oauth_state");
  const key = "oauth:" + (await hash(state));
  const row = await e.DB.prepare(
    "DELETE FROM state WHERE key=? AND expires>? RETURNING value",
  )
    .bind(key, Date.now())
    .first();
  if (!row) throw new Error("invalid_oauth_state");
  const { verifier } = JSON.parse(row.value);
  const token = await fetchJSON("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: e.GITHUB_CLIENT_ID,
      client_secret: e.GITHUB_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      redirect_uri: new URL("/auth/github/callback", r.url).href,
    }),
  });
  if (!token.access_token) throw new Error("github_exchange_failed");
  const profile = await fetchJSON("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "User-Agent": "PhotoStory",
      Accept: "application/vnd.github+json",
    },
  });
  if (!allowed(e, profile.login)) throw new Error("github_not_allowed");
  const sid = random();
  await put(
    e,
    "session:" + (await hash(sid)),
    { login: profile.login, id: profile.id },
    Date.now() + 604800000,
  );
  return redirect("/", [
    cookie(cookieName, sid, 604800),
    cookie("__Host-ps-oauth", "", 0),
  ]);
}
export async function seal(e, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(e.TOKEN_ENCRYPTION_KEY), (c) => c.charCodeAt(0)),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return {
    iv: btoa(String.fromCharCode(...iv)),
    data: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
  };
}
export async function unseal(e, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(e.TOKEN_ENCRYPTION_KEY), (c) => c.charCodeAt(0)),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const result = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Uint8Array.from(atob(value.iv), (c) => c.charCodeAt(0)),
    },
    key,
    Uint8Array.from(atob(value.data), (c) => c.charCodeAt(0)),
  );
  return JSON.parse(new TextDecoder().decode(result));
}
export const msConfigured = (e) =>
  Boolean(
    e.MICROSOFT_CLIENT_ID &&
      e.MICROSOFT_CLIENT_SECRET &&
      e.TOKEN_ENCRYPTION_KEY,
  );
const msBase = "https://login.microsoftonline.com/consumers/oauth2/v2.0/";
export async function microsoftStart(r, e, user) {
  if (!msConfigured(e)) return redirect("/?error=microsoft_not_configured");
  const limited = await limitStart(e);
  if (limited) return limited;
  const state = random(),
    verifier = random();
  await put(
    e,
    "ms-oauth:" + (await hash(state)),
    { verifier, user: user.id },
    Date.now() + 600000,
  );
  const u = new URL(msBase + "authorize");
  u.search = new URLSearchParams({
    client_id: e.MICROSOFT_CLIENT_ID,
    response_type: "code",
    redirect_uri: new URL("/auth/microsoft/callback", r.url).href,
    response_mode: "query",
    scope: "https://graph.microsoft.com/Files.Read offline_access",
    state,
    code_challenge: await challenge(verifier),
    code_challenge_method: "S256",
    prompt: "consent",
  });
  return redirect(u.href, [cookie("__Host-ps-ms", state, 600)]);
}
export async function microsoftFinish(r, e, user) {
  const u = new URL(r.url),
    state = u.searchParams.get("state"),
    code = u.searchParams.get("code");
  if (
    !msConfigured(e) ||
    !state ||
    !code ||
    cookies(r)["__Host-ps-ms"] !== state
  )
    throw new Error("invalid_oauth_state");
  const row = await e.DB.prepare(
    "DELETE FROM state WHERE key=? AND expires>? RETURNING value",
  )
    .bind("ms-oauth:" + (await hash(state)), Date.now())
    .first();
  if (!row) throw new Error("invalid_oauth_state");
  const saved = JSON.parse(row.value);
  if (saved.user !== user.id) throw new Error("invalid_oauth_state");
  const t = await fetchJSON(msBase + "token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: e.MICROSOFT_CLIENT_ID,
      client_secret: e.MICROSOFT_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      code_verifier: saved.verifier,
      redirect_uri: new URL("/auth/microsoft/callback", r.url).href,
    }),
  });
  if (!t.access_token || !t.refresh_token)
    throw new Error("microsoft_exchange_failed");
  await put(
    e,
    "microsoft",
    await seal(e, {
      access: t.access_token,
      refresh: t.refresh_token,
      expires: Date.now() + Number(t.expires_in) * 1000,
    }),
  );
  return redirect("/", [cookie("__Host-ps-ms", "", 0)]);
}
export async function microsoftToken(e) {
  const saved = await get(e, "microsoft");
  if (!saved) throw new Error("onedrive_not_connected");
  let t = await unseal(e, saved);
  if (t.expires > Date.now() + 60000) return t.access;
  const fresh = await fetchJSON(msBase + "token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: e.MICROSOFT_CLIENT_ID,
      client_secret: e.MICROSOFT_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: t.refresh,
      scope: "https://graph.microsoft.com/Files.Read offline_access",
    }),
  });
  if (!fresh.access_token) throw new Error("reauthorization_required");
  t = {
    access: fresh.access_token,
    refresh: fresh.refresh_token || t.refresh,
    expires: Date.now() + Number(fresh.expires_in) * 1000,
  };
  const updated=await e.DB.prepare("UPDATE state SET value=? WHERE key='microsoft' AND value=?")
    .bind(JSON.stringify(await seal(e,t)),JSON.stringify(saved)).run();
  if(updated.meta.changes!==1)throw new Error('reauthorization_required');
  return t.access;
}
