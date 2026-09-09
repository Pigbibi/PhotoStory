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
