# GitHub Actions processor setup

English | [简体中文](github-actions-processor.zh-CN.md)

PhotoStory runs its website on Cloudflare Workers and D1 while executing bounded scan, curation, and publishing steps in GitHub Actions with private SQLite inventory snapshots stored in R2.

The Actions processor works directly against OpenAI or Anthropic HTTPS APIs, or through an explicit OIDC Task Gateway, without any VPS daemon.

## Option A: Direct OpenAI or Anthropic API

When `AI_TASK_GATEWAY_URL` and `PHOTOSTORY_NATIVE_BINDING` are unset, `process_batch.py` selects a direct HTTPS client (`scripts/direct_ai_client.py`) using these GitHub Actions settings:

| Setting | Location | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | GitHub Actions Secret | Call OpenAI Responses API with strict JSON schema |
| `PHOTOSTORY_OPENAI_MODEL` | GitHub Actions Variable | Override default `gpt-4.1-mini` model |
| `ANTHROPIC_API_KEY` | GitHub Actions Secret | Call Anthropic Messages API using `record_result` tool output |
| `PHOTOSTORY_ANTHROPIC_MODEL` | GitHub Actions Variable | Override default Anthropic vision model |
| `PHOTOSTORY_AI_PROVIDER` | GitHub Actions Variable | Select `openai` or `anthropic` when both keys exist |

Direct API requests disable HTTP redirects, bound payload and response sizes, enforce local JSON Schema validation, and run synchronously per batch.

## Option B: Generic OIDC Task Gateway

Configure `PHOTOSTORY_URL` with your Worker origin, `PHOTOSTORY_BATCH_TOKEN` matching Worker `BATCH_TOKEN`, `AI_TASK_GATEWAY_URL` with your gateway origin, and `PHOTOSTORY_NATIVE_BINDING` as a GitHub Actions Secret:

| Field | Constraint |
| --- | --- |
| `enabled` | Must be `true`; unset or disabled stops before business I/O |
| `project` | Matches `PHOTOSTORY_PROJECT`, `GITHUB_REPOSITORY`, or default `owner/repo` |
| `service_url` | HTTPS origin of the task gateway |
| `audience` | Expected OIDC token audience |
| `adoption_age_seconds` | `1`–`3600` seconds counted from original task creation |
| `routes` | Exact keys `screen`, `group`, `cross_review`, `labels`, `strict_review`, `publication` |

Each stage route defines `mode` (`agent` or `api`), `provider` (alphanumeric identifier), `model`, `profile` (matching the stage name), and `worker`. All six stages use one consistent route configuration per binding.

Run `Process PhotoStory` manually on `main` with `cloud_native_qualification=true` to qualify one generated color-block image before real photos. If a run remains unverified, pass the saved task ID with `native_qualification_action=readback` to inspect without resubmitting.

## Async screen routing (`PHOTOSTORY_SCREEN_BINDING`)

For OIDC gateway deployments that offload slow batch screening to an asynchronous route, set `PHOTOSTORY_SCREEN_BINDING` with `job_id`, `model`, `worker` (and optional `provider`, `profile`, and `mode`).

Asynchronous screening uses the `async-screen` (or legacy compatible) profile with a 600-second timeout, resumes from saved preview hashes on callback, and wakes only the suspended batch via `/internal/screen-completed` using `SCREEN_COMPLETION_SECRET` and `SCREEN_RESUME_APP_*`.

During initial qualification, enable both `cloud_native_qualification=true` and `qualify_screen_route=true` before assigning a production `job_id`. Clear `PHOTOSTORY_SCREEN_BINDING` only after pending tasks and R2 snapshots finish cleanly.

## Inventory snapshots and scheduling

Before moving an existing VPS processor to GitHub Actions, stop the local timer, let in-flight batches finish, and seed R2 once from the private host using `scripts/cloud_inventory.py seed --directory <state-dir>`.

Enable scheduled runs by setting `PHOTOSTORY_PROCESSOR_ENABLED=true`. Snapshots are stored privately in `MEDIA_BUCKET` up to 24 MiB, reconciled atomically with D1, and pruned after seven days when superseded.

See [AI backend setup](ai-setup.md) and [security design](security-design.md) for deployment checks.
