# Security Policy

PhotoStory connects to a Microsoft account, holds OAuth tokens, and can publish to Instagram. Please report problems that could expose someone else's data, tokens, or publishing rights.

## Reporting a vulnerability

Report security vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Pigbibi/PhotoStory/security/advisories/new). Do not post exploit details, credentials, private sessions or personal data in public issues or PRs. Include the affected version, impact and minimal redacted reproduction. The maintainer handles reports on a best-effort basis; no bounty or response-time guarantee is implied.

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
