# PhotoStory

[简体中文](README.zh-CN.md)

An open-source, private photo editorial desk by **Pigbibi**, licensed under **MIT**.
Turn OneDrive camera backups into landscape photo drafts with captions
and hashtags (English by default), then review each post in a Cloudflare-hosted website.

**v0.1 is a review application, not an Instagram publisher.** There is no publishing
endpoint, Instagram token, or scheduled posting in this version. Manual approval is
the default; strict AI auto-review is an optional owner setting.
The public demo uses one clearly labelled AI-generated image; no personal photos
or live model results are included in this repository.

![Interface design concept](docs/design-concept.png)

## How it works

1. Sign in with an explicitly allowed GitHub account.
2. Authorize OneDrive through Microsoft's official consent page (`Files.Read`,
   `offline_access`). Originals are never modified or deleted.
3. Choose a folder and a bounded capture-date range, including nested year/month
   folders. Request a batch in the website.
4. Run the batch processor on your trusted VPS, using your own existing AIGateway
   installation. It claims one job, obtains a short-lived Graph access token from
   the private backend, reads previews, and asks Codex to screen them.
5. Only explicitly allowed landscape photos with no privacy flags and aesthetic
   score >= 7 enter the composition pass. Codex proposes up to three drafts, each
   with 1–8 photos, an English caption and 3–5 suggested English hashtags.
6. Review, edit, reorder, remove, save, approve, or return a draft. Editing approved
   content revokes that approval. Approval conflicts across tabs are rejected.

The interface and generated posting text default to English. The header language
switch offers 13 languages independently of AI output settings. The app's display brand is
Fieldnotes; the software project is PhotoStory. The configured date interval uses
Asia/Shanghai and an exclusive end date. Capture timestamps must include a timezone;
missing capture time is skipped rather than replaced with upload time.

## Requirements

- Node.js 22.12+ and npm; Cloudflare Workers + D1; a GitHub account.
- Your own GitHub OAuth App and Microsoft Entra application registration supporting
  personal Microsoft accounts. Cloudflare secrets are configured server-side.
- Python 3.11+, Pillow, and a trusted, authenticated Codex installation exposed
  through AIGateway's `bin/codex-gateway` CLI contract.

The web app uses React/Vite; its Worker uses standard Web APIs with no server
framework. Python uses the standard library plus Pillow to normalize previews,
apply orientation and strip EXIF metadata. There is no paid model API dependency.
Cloudflare usage and Codex limits still depend on your own account plans.

## Deploy your own

```sh
npm ci
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
npm run build
cp wrangler.jsonc wrangler.local.jsonc
npx wrangler d1 create photostory
```

Edit `wrangler.local.jsonc`: choose a unique Worker/database name, replace the D1
database ID, and set `ALLOWED_GITHUB_USERS` to your exact GitHub username. This
local configuration is ignored by Git. Never widen the allowlist to `*`.

```sh
npx wrangler d1 execute photostory --remote --file worker/schema.sql --config wrangler.local.jsonc
npx wrangler deploy --config wrangler.local.jsonc
```

The public shell and demo are available immediately. Private data endpoints deny
unauthenticated access, and OAuth stays disabled until fully configured.

### GitHub sign-in

Create a dedicated OAuth App in [GitHub developer settings](https://github.com/settings/developers):

- Homepage: your deployed site's HTTPS origin.
- Callback: `https://YOUR-SITE/auth/github/callback`.
- No repository write scope is requested. Identity is checked against the server's
  exact GitHub username allowlist.

Set secrets with the interactive Cloudflare prompt (never paste secrets in chat):

```sh
npx wrangler secret put GITHUB_CLIENT_ID --config wrangler.local.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --config wrangler.local.jsonc
```

GitHub login credentials from another app are not reused: its callback registration
belongs to that other app. We follow the invoice portal's server-side OAuth/session
pattern with separate credentials, cookies, and database storage.

### OneDrive authorization

In [Microsoft Entra](https://entra.microsoft.com/), register an application supporting
personal Microsoft accounts. Add a **Web** redirect URI:
`https://YOUR-SITE/auth/microsoft/callback`. Create a client secret and configure:

```sh
npx wrangler secret put MICROSOFT_CLIENT_ID --config wrangler.local.jsonc
npx wrangler secret put MICROSOFT_CLIENT_SECRET --config wrangler.local.jsonc
```

Generate a cryptographically random 32-byte key, base64-encode it, and place it in
`TOKEN_ENCRYPTION_KEY` using the same secret prompt. The Worker encrypts Microsoft
refresh/access tokens with AES-GCM before storing them in D1. Preserve this key
securely; changing it requires reconnecting OneDrive. Then sign in to PhotoStory,
open **连接设置**, and click **连接 OneDrive** to complete Microsoft's consent.

`Files.Read` is an account-level delegated read permission. Folder selection is
enforced by the scanner, not a Microsoft folder-scoped OAuth grant. The application
recurses only under the selected root, skips remote shortcuts and screenshot
filenames, and applies capture-date bounds. Review previews contain no EXIF/GPS.

The `AUTH_LIMITER` binding in the template is required for OAuth login. Choose an account-unique rate-limit namespace ID. It limits starts to 20 per minute per Cloudflare location. Reapply `worker/schema.sql` when upgrading to add the expiry index; auth activity incrementally removes expired state without deleting Microsoft tokens.

The narrow Miniflare → sharp override pins patched 0.35.4 until upstream updates its exact dependency.

### Connect your existing Codex VPS

This project does not ship or access Pigbibi's private AIGateway service. Deployers
must provide their own gateway. The adapter consumes this existing CLI contract:
`--prompt-file`, repeated `--image`, `--output-schema`, `--out`, `--providers codex`,
`--sandbox read-only`, `--ask-for-approval never`, `--cwd`, and bounded timeout.

Before connecting real photos, use a dedicated runtime whose model process cannot read unrelated home/config/credential files. Read-only access alone is insufficient. The adapter uses an environment allowlist and forces local Codex; this is not filesystem isolation. Verify the gateway’s effective tool, network and filesystem restrictions.

On the trusted VPS, install the small Python dependency in a virtual environment:

```sh
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
```

Generate a separate random machine secret of at least 32 bytes. Store the same
value in Cloudflare's `BATCH_TOKEN` and in a permission-0600 VPS environment file
as `PHOTOSTORY_BATCH_TOKEN`. The VPS environment also needs:

```text
PHOTOSTORY_URL=https://YOUR-SITE
CODEX_GATEWAY_COMMAND=/path/to/your/aigateway/bin/codex-gateway
CODEX_GATEWAY_BACKEND=local
PHOTOSTORY_STATE_DIR=/absolute/private/photostory-state
```

Do not commit that file. Load it through your process manager's `EnvironmentFile`
or another restricted environment mechanism. Then run:

```sh
.venv/bin/python scripts/process_batch.py
```

One invocation handles a bounded step: at most 50 Graph pages or one AI batch.
The supplied optional systemd timer continues owner-created jobs and checks the
owner's weekly/monthly schedule, which is disabled by default. Scheduled runs have
a separate total analysis budget (default 100); the pending-review threshold
(default 20 drafts) pauses further batches. Install the timers using the systemd
deployment guide. This adapter intentionally uses the local backend. Any separate service integration must preserve AIGateway's GitHub Actions OIDC repository/workflow/ref allowlists and HTTPS protections. A private
GitHub Action may not be callable from public repositories; the documented VPS CLI
path avoids depending on access to a private action from this public project.

## Privacy and selection policy

Review drafts and approved drafts have no automatic expiry. Discarded drafts enter
a 30-day recycle bin and can be restored as unapproved drafts. Daily cleanup removes
expired trash and only previews with no remaining draft reference. Photos removed
while editing also get a 30-day grace period. Temporary-residue cleanup uses a
separate idle-only VPS unit. Neither cleanup process deletes OneDrive originals.
See [lifecycle and scheduling](docs/lifecycle.zh-CN.md) for configuration and upgrade steps.

The policy is in `scripts/process_batch.py` (`SCREEN_PROMPT`, `GROUP_PROMPT`).
See [privacy and limits](docs/privacy.md) before supplying real photos.

- Safety is checked before aesthetics and grouping; uncertain, missing and invalid
  decisions never become drafts. Unknown/duplicate photo IDs are rejected.
- Models can still make mistakes. A score is not proof of safety or objective
  beauty. Manual review is the default. Optional strict AI review reduces risk but cannot
  guarantee privacy or good taste; the owner remains responsible for enabling it.
- Previews must reach Codex to be screened. Sensitive source images may therefore
  be processed by your configured Codex path even when later excluded. This is not
  an on-device privacy filter and does not change Codex's service data policies.
- Only selected safe previews and drafts enter private D1 storage. No private
  data is stored in the repository, public assets, GitHub artifacts or browser
  localStorage (only the interface language preference is stored there). The public generated demo never enters the real draft backend.
- Batch processor logs only generic status/counts. Rejected previews are removed
  from its private temporary directory; all temporary input/output is removed when
  the process exits normally. No cross-provider fallback is allowed.
- Choose the last 1/3/6/12 months, all eligible photos, or an inclusive custom date
  range. Metadata discovery resumes across bounded steps; AI batches default to
  50 photos, at most 100. Large ranges continue automatically with the timer.
  The UI shows progress and can stop subsequent batches; the current batch finishes.
- Private VPS SQLite state stores paging cursors, candidate IDs/times/coarse locations
  and version/preview hashes. Completed analysis, including exclusions, is reused.
  Preserve this state across deployments. Missing state or an uncertain AI outcome
  stops affected work; do not blindly recreate or reset a running job.

## Validation and current release limits

Run `npm test`, the Python unittest command above, and `npm run build`.
Node tests cover private-route protection, exact allowlisting, CSRF, OAuth state,
token encryption, and review/approval transitions. Python tests cover privacy
gates, allowed photo references, timestamp handling and token origin boundaries.

Real GitHub OAuth, Microsoft consent/refresh, your actual folder format, Codex
visual results and VPS operation require your deployment configuration and an
explicit live run. Unit tests and the demo do not verify those integrations.
Instagram scheduling/publishing is intentionally not implemented in v0.1.

## License

[MIT](LICENSE), copyright 2026 Pigbibi. Deploy your own instance with your own
accounts, keys and service permissions.

Linux VPS isolation setup: [two-user systemd deployment](deploy/systemd/README.md).

AI modes and setup: [Chinese step-by-step guide](docs/ai-setup.zh-CN.md), including API cost considerations and current support limits.

## AI caption language

The website defaults to **English**. Use the header language selector to switch
instantly; it stores only a language code in this browser. Arabic uses RTL layout.
Documentation is maintained in English and Simplified Chinese only.

Set these **non-secret Worker vars** in `wrangler.jsonc` (or your private deployment
config / Cloudflare Settings → Variables and Secrets), then deploy:

| Variable | Default | Controls |
| --- | --- | --- |
| `AI_CAPTION_LANGUAGE` | `en` | Caption, 3–5 hashtags, and photo alt text |
| `AI_EDITOR_LANGUAGE` | `en` | Short draft title and selection explanation |

Both accept: `en`, `zh-CN`, `zh-TW`, `ja`, `ko`, `es`, `fr`, `de`, `pt`, `it`,
`ru`, `ar`, `hi`. These are also the interface languages. For example, use
`AI_CAPTION_LANGUAGE="en"` and `AI_EDITOR_LANGUAGE="zh-CN"` for English posts
with Chinese editing notes. Invalid codes reject new job creation before AI use.
The same variables apply to manual and scheduled jobs; browser clients cannot
override them. No additional AI provider, login, or paid API is introduced.

Language settings are frozen when a job is created. Changing them affects new jobs
only and never rewrites existing drafts. Jobs created before this feature retain
English captions and Chinese editing notes. Previously processed photos remain
cached; changing language alone does not create duplicate drafts or reanalyze them.
Deploy the updated Worker and VPS processor together before creating new jobs.
Model-generated language is best effort; review text before approving it.

## Consistent carousel framing

In the review editor, choose one canvas ratio for the whole draft: **4:5 portrait**,
**1:1 square**, or **3:2 landscape**. Each photo can keep its full image with white
borders (default) or fill the canvas by cropping. Crop mode provides horizontal and
vertical position sliders. The main preview and filmstrip use the same saved frame.
Position percentages are measured across the available overflow; when an axis has
no overflow, moving its slider has no visual effect. Images are never stretched.

Save and inspect every frame before approval. Changing the ratio or any photo's
framing revokes prior approval, just like changing the caption. Framing survives
reordering, trash, and restore; the OneDrive originals remain untouched.

This version saves **composition parameters and review previews only**. It does not
export full-resolution images or publish to Instagram. A future export/publishing
path must fetch the matching originals, apply the saved canvas and crop positions,
and verify the resulting files against the publishing channel's current requirements.
Do not use the 768px review previews as full-quality publishing files.

## Review mode: manual or strict AI

In Connection Settings → production/retention rules, choose **Manual approval**
(default) or **Strict AI auto-review**, then save. This setting applies to new
manual and scheduled jobs independently of whether periodic production is enabled.
It never retrospectively approves existing drafts. Switching back to manual also
blocks automatic approval by any batch still in flight, checked in the database
write transaction.

Strict mode requires every selected photo to have an initial aesthetic score of
**9/10 or higher**, be outdoor scenery, and have no privacy flags. It then makes a
**separate AI call** to inspect the complete post and its actual default 4:5,
white-bordered previews. Privacy, grounded text and locations, coherent theme,
composition, and absence of repetitive frames must all pass; any uncertainty,
missing field, malformed response, low score, or extra-review failure leaves the
post for manual review. This extra call consumes additional Codex quota. It uses
the same configured service/model, not an independent provider or a safety guarantee.

The server binds the result to the draft text, photo IDs/order and default framing;
client-supplied approval status cannot bypass these checks. Approved posts are
labelled as AI-reviewed in the private queue. Changing text, photos or framing
revokes approval and requires manual re-review. There is still **no Instagram
publishing**. Scores are a selection rule, not a calibrated probability of safety.
