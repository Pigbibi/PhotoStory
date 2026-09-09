# PhotoStory security review

Reviewed 2026-09-10 against commit `006c930`, source, dependency audit and the deployed anonymous endpoints. This is a bounded review, not a penetration-test certification. No personal photo or production OAuth token was used. The existing VPS gateway service settings were inspected read-only; no dedicated PhotoStory processor is configured yet.

The repository can be public while each deployment keeps its photos and credentials private. No credential patterns were found in the three Git revisions inspected; this does not prove the absence of every possible secret. Production npm dependencies have no reported advisories. Login resource limits and the development dependency advisory have now been repaired and verified locally. Before real photo processing, verify the remaining VPS filesystem/tool isolation described below.

## Medium — repaired

### 1. Public login can create unbounded persistent OAuth records

`worker/auth.mjs:77` creates a fresh D1 row for every configured GitHub login start. `worker/auth.mjs:22` persists it; `worker/auth.mjs:29` only checks expiry during reads. No rate limiter or expired-record cleanup exists in the Worker/configuration. An anonymous client can exhaust database storage/write quotas and interrupt legitimate access after OAuth is configured. This is an availability issue, not an authentication bypass. No load attack was performed against production.

Repair: both OAuth starts now use a fixed-key limiter before database writes (20 starts/minute/location). Missing limiter configuration returns 503; exhausted limits return 429. Auth writes remove at most 256 expired records through an expiry index. Tests verify no writes on rejection and preservation of active sessions and provider tokens. Cleanup runs on subsequent authentication activity; it is not a timer or immediate TTL deletion. Cloudflare's native limiter is approximate and local to each edge location, so it is abuse mitigation, not a global hard quota.

## Conditional — verify before enabling the VPS processor

### 2. The model subprocess inherits host authority beyond the photo prompt

`scripts/process_batch.py:188` requests a read-only sandbox; the reviewed base at `scripts/process_batch.py:193` copied the process environment and removed selected credential names. The repair now uses `gateway_environment()` with a small allowlist and forces the local Codex backend; regression coverage rejects unrelated credentials and loader hooks. This addresses environment inheritance, not filesystem/tool isolation. This does not prove other host credentials are absent or that unrelated files are unreadable. Prompt instructions to avoid tools are not an access-control mechanism. Impact could be high if the runtime user can read unrelated credentials and model tool use is available. A live read-only check found the existing gateway runs as `ubuntu`, with `ProtectHome=read-only`, `ProtectSystem=full`, `PrivateTmp=yes` and `NoNewPrivileges=yes`. These are useful protections but do not make home files unreadable. The dedicated PhotoStory runtime, effective model tool access and readable-file boundaries remain unverified; no credential contents were read.

Use a dedicated restricted runtime, a minimal environment and filesystem view, and keep the machine/Graph credentials outside model-readable files. Verify actual gateway tool and network restrictions before processing private previews. Do not run the scanner as an unrestricted shared administrator account.

## Dependency advisory — development environment, repaired

### 3. Wrangler's development dependency chain includes vulnerable sharp

The locked chain is Wrangler → Miniflare → sharp. Full `npm audit` reports GHSA-rgj7-g3m4-5g8c, rated high, through three dependency entries; these are one underlying advisory chain, not three independent application flaws. `npm audit --omit=dev` reports zero vulnerabilities. The deployed Worker does not import sharp or expose a Miniflare image transformation endpoint, so remote production exploitability was not established.

Repair: Miniflare's exact sharp dependency is overridden to patch version 0.35.4. Full npm audit now reports zero advisories. A real sharp JPEG encode succeeds, and the frontend build passes. Wrangler itself was not downgraded. Remove the narrow override after upstream adopts a patched version.

## Permission and privacy boundaries

- GitHub OAuth requests no scopes and uses the access token only to read public identity. Exact allowed usernames are checked on every session access (`worker/auth.mjs:40`). The app does not request repository access. This is a single shared private deployment, not isolated accounts for multiple tenants.
- Microsoft requests delegated `Files.Read` and `offline_access` (`worker/auth.mjs:204`). It cannot write/delete OneDrive files through these grants, but the read grant is broader than the selected folder. The scanner enforces folder/date selection, not Microsoft OAuth.
- The trusted machine credential can claim queued work and obtain a Graph access token (`worker/index.mjs:100`). That token can read beyond the requested folder. The VPS is therefore part of the trusted system; the machine token must not be exposed to browsers, models or public CI. A job lease is not a replacement for this trust boundary.
- Microsoft tokens are encrypted with AES-GCM in D1. The encryption key belongs in Worker Secrets, separately from D1 and Git. Anyone administering the Worker can access its effective authority. Never commit local deployment/secrets files.
- Private APIs and previews require server-side authentication; secure HttpOnly cookies, one-use browser-bound OAuth state, PKCE, mutation Origin checks, no-store responses and a restrictive CSP are present. React renders draft text without an HTML injection sink.
- AI receives previews before deciding whether they are sensitive. The screening prompt cannot guarantee zero mistakes or prevent the model service from seeing a rejected preview. Review images are reduced to 768px, which can hide details. Human approval is required and IG publishing is disabled.
- Selected previews persist until the owner removes them; v0.1 has no retention purge or in-app OneDrive disconnect control. Provider-side revocation remains available. Do not describe retention as temporary or folder access as provider-enforced.

## Checks and limits

- Three local Git revisions scanned for common access-token/private-key patterns: no matches; no credential values emitted.
- Live Cloudflare secret inventory was empty at the beginning of configuration; only the public GitHub Client ID has since been configured. No client secret, Microsoft token or batch credential has been handled.
- Live anonymous private endpoints reject access; configuration and OAuth completion still require real account setup.
- Source inspection covered Worker authentication, machine routes, preview handling, frontend sinks, processor credential handling and CI permissions. CI has read-only repository permission and no deployment credentials.
- Existing gateway service hardening was inspected without changing it or calling AI. Its directory is not a Git checkout, so a deployed source revision was not established. Dedicated processor isolation, Microsoft consent, real photo selection and AI service retention were not verified. No claim of end-to-end readiness is made.

References: [GitHub scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps), [Microsoft permissions](https://learn.microsoft.com/en-us/graph/permissions-reference), [Cloudflare rate limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [sharp advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c).
