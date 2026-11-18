# Security design and deployment checks

English | [简体中文](security-design.zh-CN.md)

PhotoStory accesses personal photo libraries, holds encrypted OAuth tokens, and optionally publishes to Instagram. Keep these structural boundaries intact across all deployments and forks.

## Authentication and browser boundaries

- Every private API endpoint and image route verifies a server-side D1 session cookie; public static pages are never an authorization boundary.
- The `ALLOWED_GITHUB_USERS` allowlist is rechecked on every authenticated request. GitHub sign-in requests no repository scopes and discards GitHub access tokens after lookup.
- Session cookies use random IDs with `HttpOnly`, `Secure`, and `SameSite=Lax`. State-changing requests require a matching `Origin`.
- OAuth logins use single-use state tokens, PKCE, and rate limiting via `AUTH_LIMITER`; never disable that binding in production.

## Credentials and service isolation

- Microsoft and Instagram OAuth tokens are encrypted at rest in D1 using AES-GCM keyed by `TOKEN_ENCRYPTION_KEY`.
- Each Worker isolate caches the imported `CryptoKey` per secret value and re-imports immediately on rotation, never caching plaintext tokens or authentication outcomes.
- `BATCH_TOKEN` (`PHOTOSTORY_BATCH_TOKEN`) belongs strictly to the Worker and trusted processor environment. Never expose it to browsers, models, public PR workflows, or logs; rotate both sides on any suspected leak.
- AI invocations pass only bounded prompts and EXIF-free previews. AI runtimes never receive OneDrive refresh tokens, Worker secrets, `BATCH_TOKEN`, or Instagram credentials.
- Never commit secrets, database exports, `wrangler.local.jsonc`, `.env` files, callback URLs, or temporary publishing links.

## Photo and storage boundaries

- OneDrive access is strictly read-only; PhotoStory never modifies or deletes source images.
- Thumbnail downloads allow only verified Microsoft image origins, disable redirects, and never forward Microsoft Graph bearer tokens to download hosts.
- D1 databases and R2 media buckets (`MEDIA_BUCKET`) must remain private with no `r2.dev` endpoints or public bucket policies.
- Prepared publishing JPEGs use short-lived, state-checked URLs expiring after one hour; never share those links externally.

## AI and publishing boundaries

- Prompts, filenames, captions, EXIF, and AI JSON outputs are untrusted data, never executable instructions.
- AI screening and cross-review are fallible safeguards, not privacy guarantees. Manual review and manual publishing remain the default.
- Preference signals only guide grouping and strict-review tie-breaking; they can never approve unsafe photos or trigger publication.
- Publishing refuses to replay ambiguous or incomplete external requests automatically; verify state on Instagram and in private records first.

## Deployment checklist

1. Create independent Cloudflare Workers, D1 databases, R2 buckets, OAuth apps, and machine secrets for your own installation.
2. Keep `wrangler.local.jsonc` and local environment files untracked and mode `0600` (`0700` for state directories).
3. Run `npm test`, Python unit tests, `npm run build`, and `python3 scripts/check_hygiene.py --strict` before deploying.
4. Test OAuth, one small bounded batch, and manual publishing in a controlled environment before enabling automation.
5. Keep production logs redacted to fixed stage names and HTTP status codes without payloads or tokens.

These application controls supplement, rather than replace, operator responsibility for account access, retention choices, AI provider terms, and Meta platform rules.
