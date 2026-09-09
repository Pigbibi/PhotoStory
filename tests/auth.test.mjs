import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.mjs";
import { allowed, configured, seal, unseal } from "../worker/auth.mjs";
const request = (path, options = {}) =>
  new Request("https://app.example" + path, options);
const assets = { fetch: () => new Response("<html>public shell</html>") };
test("D1 image byte arrays are returned as binary, not text", async () => {
  const db = {
    prepare: (sql) => ({
      bind: () => ({
        first: async () =>
          sql.startsWith("SELECT value")
            ? {
                value: JSON.stringify({ login: "Pigbibi" }),
                expires: Date.now() + 10000,
              }
            : { data: [255, 216, 255], mime: "image/jpeg" },
      }),
    }),
  };
  const response = await worker.fetch(
    request("/api/photos/photo", {
      headers: { Cookie: "__Host-photostory=test" },
    }),
    { DB: db, ALLOWED_GITHUB_USERS: "Pigbibi" },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    [...new Uint8Array(await response.arrayBuffer())],
    [255, 216, 255],
  );
});
test("private photos, drafts, jobs reject anonymous requests", async () => {
  for (const p of ["/api/photos/private", "/api/drafts", "/api/jobs"]) {
    const r = await worker.fetch(request(p), { ASSETS: assets });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.ok(
      r.headers
        .get("content-security-policy")
        .includes("frame-ancestors 'none'"),
    );
  }
});
test("API does not trust forged login headers or unknown cookies", async () => {
  const r = await worker.fetch(
    request("/api/drafts", {
      headers: { "X-User": "Pigbibi", Cookie: "__Host-photostory=forged" },
    }),
    {
      DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
      ALLOWED_GITHUB_USERS: "Pigbibi",
    },
  );
  assert.equal(r.status, 401);
});
test("machine routes require a configured exact token", async () => {
  for (const headers of [{}, { Authorization: "Bearer wrong" }]) {
    assert.equal(
      (
        await worker.fetch(
          request("/internal/claim", { method: "POST", headers }),
          { BATCH_TOKEN: "correct" },
        )
      ).status,
      401,
    );
  }
});
test("ordinary browser session cannot call machine routes", async () => {
  assert.equal(
    (
      await worker.fetch(
        request("/internal/source", {
          method: "POST",
          headers: { Cookie: "__Host-photostory=session" },
        }),
        {},
      )
    ).status,
    401,
  );
});
test("allowlist matches exact login rather than substring", () => {
  assert.equal(allowed({ ALLOWED_GITHUB_USERS: "Pigbibi" }, "pigbibi"), true);
  assert.equal(
    allowed({ ALLOWED_GITHUB_USERS: "Pigbibi" }, "Pigbibi-evil"),
    false,
  );
  assert.equal(
    configured({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" }),
    false,
  );
});
test("tokens are encrypted, authenticated, and not stored as plaintext", async () => {
  const e = {
    TOKEN_ENCRYPTION_KEY: btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
    ),
  };
  const enc = await seal(e, { refresh: "private-token" });
  assert.ok(!JSON.stringify(enc).includes("private-token"));
  assert.deepEqual(await unseal(e, enc), { refresh: "private-token" });
  await assert.rejects(() =>
    unseal(e, { ...enc, data: "AA" + enc.data.slice(2) }),
  );
});
test("unconfigured OAuth does not redirect to an external provider", async () => {
  const r = await worker.fetch(request("/auth/github/start"), {});
  assert.equal(r.headers.get("location"), "/?error=github_not_configured");
});
test("valid browser session cannot mutate from another origin", async () => {
  const db = {
    prepare: () => ({
      bind: () => ({
        first: async () => ({
          value: JSON.stringify({ login: "Pigbibi" }),
          expires: Date.now() + 10000,
        }),
      }),
    }),
  };
  const r = await worker.fetch(
    request("/api/jobs", {
      method: "POST",
      headers: {
        Cookie: "__Host-photostory=session",
        Origin: "https://evil.invalid",
      },
    }),
    { DB: db, ALLOWED_GITHUB_USERS: "Pigbibi" },
  );
  assert.equal(r.status, 403);
});
test("invalid OAuth state cannot reach token exchange", async () => {
  const r = await worker.fetch(
    request("/auth/github/callback?code=abc&state=wrong"),
    {
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
      ALLOWED_GITHUB_USERS: "Pigbibi",
    },
  );
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "invalid_oauth_state" });
});

test("configured OAuth fails closed without its abuse limiter", async () => {
  let writes = 0;
  const e = {
    GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret", ALLOWED_GITHUB_USERS: "Pigbibi",
    DB: { prepare: () => ({ bind: () => ({ run: async () => { writes++; } }) }) },
  };
  const r = await worker.fetch(request("/auth/github/start"), e);
  assert.equal(r.status, 503);
  assert.equal(writes, 0);
});

test("rate-limited OAuth never creates database state", async () => {
  let writes = 0;
  const e = {
    GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret", ALLOWED_GITHUB_USERS: "Pigbibi",
    AUTH_LIMITER: { limit: async () => ({ success: false }) },
    DB: { prepare: () => ({ bind: () => ({ run: async () => { writes++; } }) }) },
  };
  const r = await worker.fetch(request("/auth/github/start"), e);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("retry-after"), "60");
  assert.equal(writes, 0);
});

test("allowed OAuth uses fixed limiter key and cleans expired records before insertion", async () => {
  const calls = [];
  const e = {
    GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret", ALLOWED_GITHUB_USERS: "Pigbibi",
    AUTH_LIMITER: { limit: async (input) => { calls.push(input); return { success: true }; } },
    DB: { prepare: (sql) => ({ bind: (...args) => ({ run: async () => { calls.push({ sql, args }); } }) }) },
  };
  const r = await worker.fetch(request("/auth/github/start?attackerKey=arbitrary"), e);
  assert.equal(r.status, 302);
  assert.deepEqual(calls[0], { key: "photostory:oauth-start" });
  assert.match(calls[1].sql, /DELETE FROM state/);
  assert.match(calls[1].sql, /expires <= \?/);
  assert.match(calls[2].sql, /INSERT INTO state/);
  const target = new URL(r.headers.get("location"));
  assert.equal(target.searchParams.get("code_challenge_method"), "S256");
  assert.equal(target.searchParams.has("scope"), false);
});

test("expiry cleanup preserves live sessions and encrypted provider tokens in SQLite", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync } = await import("node:fs");
  const { put } = await import("../worker/auth.mjs");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8"));
    const insert = db.prepare("INSERT INTO state VALUES(?,?,?)");
    insert.run("oauth:expired", "{}", Date.now() - 1);
    insert.run("session:live", "{}", Date.now() + 60000);
    insert.run("microsoft", "encrypted-fixture", null);
    const env = { DB: { prepare: (sql) => ({ bind: (...args) => ({ run: async () => db.prepare(sql).run(...args) }) }) } };
    await put(env, "oauth:new", { verifier: "fixture" }, Date.now() + 60000);
    assert.deepEqual(db.prepare("SELECT key FROM state ORDER BY key").all().map(r => r.key), ["microsoft", "oauth:new", "session:live"]);
    assert.equal(db.prepare("SELECT value FROM state WHERE key='microsoft'").get().value, "encrypted-fixture");
  } finally { db.close(); }
});
