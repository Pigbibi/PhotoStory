# Security Policy

PhotoStory connects to a Microsoft account, holds OAuth tokens, and can publish to Instagram. Please report problems that could expose someone else's data, tokens, or publishing rights.

## Reporting

Open an issue only for problems that are safe to describe in public. For anything involving live tokens, account access, or a way to read another deployment's data, say so **without** the exploit details and ask for a private channel — the maintainer will follow up.

Do not paste any of the following into an issue, pull request, comment, or screenshot:

- Microsoft or GitHub access tokens, refresh tokens, cookies, or session values
- `TOKEN_ENCRYPTION_KEY`, `BATCH_TOKEN`, or any Worker secret
- Real photo URLs, OneDrive share links, or EXIF data
- Your Cloudflare account ID, D1 database ID, or R2 bucket name
- Contents of `wrangler.local.jsonc`

Redact logs before posting. A stack trace is usually enough.

## What to include

- What an attacker gains, and what they need to start
- Which component is affected: Worker, processor, D1 schema, or the Actions workflow
- Whether it reproduces on a fresh deployment or only on a configured one
- Your deployment shape, if relevant (single owner, multiple allowed GitHub users, scheduled processor on or off)

## Scope

In scope:

- Reading or writing another deployment's drafts, settings, or publication history
- Escaping the `ALLOWED_GITHUB_USERS` allowlist
- Getting the AI runtime access to OneDrive tokens, Worker secrets, or publishing authority
- Publishing without owner approval when approval is required
- Prompt injection that survives the untrusted-data boundary and changes what gets published

Out of scope:

- Model output being wrong, generic, or low quality — that is expected, and review exists for it
- Missing a duplicate photo or an incorrect place name; the README states these are best-effort
- Anything requiring the attacker to already hold your Cloudflare, GitHub, or Microsoft credentials
- Rate limits, quotas, or Instagram API behaviour changes

## Supported versions

The `main` branch. This project has no long-term support branches — deploy from `main` or pin a commit yourself.

## Response

Reports are reviewed on a best-effort basis by a single maintainer. There is no bounty program and no response-time guarantee. Fixes ship when they ship; security-relevant changes are described in the commit message.
