# PhotoStory

[简体中文](README.zh-CN.md)

An open-source, private photo editorial desk by **Pigbibi**, licensed under **MIT**.
Turn OneDrive camera backups into landscape photo drafts with captions
and hashtags (English by default), then review each post in a Cloudflare-hosted website.

**Manual Instagram publishing is available for approved photo drafts.** Prepare
original-based JPEGs, review the exact output, then explicitly publish to the
connected professional account. Both single images and carousels (up to eight
photos) are supported. Manual approval remains the default; strict AI auto-review
is optional. Automatic publishing is a separate, off-by-default setting.
The public demo uses one clearly labelled AI-generated image; no personal photos
or live model results are included in this repository.

![Interface design concept](docs/design-concept.png)


Instagram authorization is renewed automatically by the existing VPS maintenance timer when fewer than 30 days remain. Keep that timer online even when scheduled photo generation is disabled. Failures preserve the old connection; expired or revoked authorization requires reconnection. See [Instagram setup](docs/instagram-setup.md).


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
   score >= 7 enter the composition pass. A separate people-role field must classify
   them as having no people or only incidental passersby/passengers; selfies, posed
   groups, portraits and uncertain roles are excluded. A clear-composition check
   must also pass: heavy foreground/window obstructions are excluded. Codex proposes up to three drafts, each
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
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
npm run build
cp wrangler.jsonc wrangler.local.jsonc
npx wrangler d1 create photostory
```

Edit `wrangler.local.jsonc`: choose a unique Worker/database name, replace the D1
database ID, and set `ALLOWED_GITHUB_USERS` to your exact GitHub username. This
local configuration is ignored by Git. Never widen the allowlist to `*`.

```sh
npx wrangler d1 execute photostory --remote --file worker/schema.sql --config wrangler.local.jsonc
npm run deploy
```

`npm run preview` and `npm run deploy` deliberately use the ignored
`wrangler.local.jsonc`. This prevents a copied public template from targeting
someone else's Worker or database; create the local file before running either
command.

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
a separate total analysis budget (default 300); the pending-review threshold
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
- Only selected safe previews and drafts enter private storage (D1 metadata, with optional private R2 images). No private
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
Manual publishing is the default. Validate your first manual post with your own account before opting into automatic publishing.

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

New AI batches separate photos by their decoded image orientation before theme
selection: landscape → **3:2**, portrait → **4:5**, square → **1:1**. Orientations
cannot mix within a generated post. AI selects crop positions to fill the canvas
without borders and is instructed to omit images whose important subjects would
be clipped. Inspect the saved crops: AI composition judgments can be wrong.
This can make up to three grouping calls per batch, within the existing total
of three drafts. Update both the Worker and VPS scripts before starting a new job;
existing drafts and their approvals are not rewritten.

In the review editor, choose one canvas ratio for the whole draft: **4:5 portrait**,
**1:1 square**, or **3:2 landscape**. Each photo can keep its full image with white
borders or fill the canvas by cropping (the default for new AI batches). Crop mode provides horizontal and
vertical position sliders. The main preview and filmstrip use the same saved frame.
Position percentages are measured across the available overflow; when an axis has
no overflow, moving its slider has no visual effect. Images are never stretched.

Save and inspect every frame before approval. Changing the ratio or any photo's
framing revokes prior approval, just like changing the caption. Framing survives
reordering, trash, and restore; the OneDrive originals remain untouched.

Approved drafts can be downloaded with **Download ZIP**: one numbered JPEG per
photo, `caption.txt`, and `alt-text.txt`. Canvas sizes are 1080×1350 (4:5),
1080×1080 (1:1), or 1080×720 (3:2). Browser canvas rendering applies the saved
fit/crop and position, removes original EXIF/GPS metadata, and creates the ZIP
using the MIT-licensed fflate library, loaded only when exporting.

Originals are fetched through the authenticated Worker from OneDrive and handled
transiently in memory; they are not stored in D1, R2 or the repository. Export
requires a currently approved, unchanged draft. The original's item identity and
eTag-derived version must match the reviewed source before and after download.
Graph bearer tokens and preauthenticated download URLs never reach the browser;
download hosts are restricted to Microsoft hosts and redirects are rejected.
The final draft version is checked again before the browser offers the ZIP.

JPEG/PNG originals only, up to 25 MB and 50 megapixels per image. Originals are
processed sequentially, without upscaling; unsupported, missing, changed or too-small
files stop the whole export. HEIC needs a supported conversion path before export.
The 768px review previews are never substituted for unavailable originals.

New imports save a private immutable item/version reference. Old installations can
backfill from their existing private scanner SQLite records using the machine-only
`/internal/photo-sources` endpoint: GET lists up to 100 missing IDs; POST accepts at
most 10 `{id,item,fingerprint,policy}` entries and verifies each legacy fingerprint
against Graph before insertion. It never replaces an existing reference. Source
references are collected when their preview is removed by normal retention cleanup.
An unverified old source requires rescanning and review; do not manually substitute
its current version. No additional Microsoft permissions or storage service is needed.

Export itself does not publish. Use the separate Instagram publishing panel after approval.

## Review mode: manual or strict AI

In Connection Settings → production/retention rules, choose **Manual approval**
(default) or **Strict AI auto-review**, then save. This setting applies to new
manual and scheduled jobs independently of whether periodic production is enabled.
It never retrospectively approves existing drafts. Switching back to manual also
blocks automatic approval by any batch still in flight, checked in the database
write transaction.

Strict mode requires every selected photo to have an initial aesthetic score of
**9/10 or higher**, be outdoor scenery, and have no privacy flags. It then makes a
**separate AI call** to inspect the complete post and previews rendered with its
actual saved aspect ratio and crop positions. Privacy, grounded text and locations, coherent theme,
composition, and absence of repetitive frames must all pass; any uncertainty,
missing field, malformed response, low score, or extra-review failure leaves the
post for manual review. This extra call consumes additional Codex quota. It uses
the same configured service/model, not an independent provider or a safety guarantee.

The server binds the result to the draft text, photo IDs/order, aspect ratio and every crop position;
client-supplied approval status cannot bypass these checks. Approved posts are
labelled as AI-reviewed in the private queue. Changing text, photos or framing
revokes approval and requires manual re-review. In manual publishing mode, publishing requires an explicit action in the final preview. Scores are a selection rule, not a calibrated probability of safety.

Instagram app preparation and credential handling: [setup guide](docs/instagram-setup.md).

The machine-only `/internal/photo-sources` recovery endpoint accepts `dryRun: true`
to validate existing scan references against OneDrive without saving mappings.
Only proceed with recovery after this preflight succeeds; a changed source must
be scanned and reviewed again.

Draft titles and selection explanations are display metadata. The processor
translates them into all 13 interface languages through the same isolated AI
service, using text only. Switching the website language does not change the
original title, caption, photo order, framing, version, or approval. Editing a
title clears its cached translations and requires approval again. Missing
translations fall back to the original text; arbitrary user text is never looked
up in the static UI dictionary.

For existing drafts, an administrator can export private `id`, `title`, `reason`
records and run `scripts/translate_labels.py --input labels.json --output translated.json`
with the configured `CODEX_GATEWAY_COMMAND` (up to five drafts per invocation).
Merge only each result's `translations` field into its matching database record,
conditionally on the unchanged source title, reason and version. Never replace
an entire approved draft. Keep both JSON files private and remove temporary
copies after verification. Upgrade both isolated gateway scripts before using
text-only translation. No new AI credentials or provider are required.

## Optional automatic publishing

Connection Settings → Publishing mode offers **Manual publishing (default)** and
**Strict AI automatic publishing**. Select a mode and save; the owner-only,
same-origin, version-checked settings API persists it in private D1 state across
redeployments. No source edit, secret in GitHub, or database migration is needed.
Existing installations remain manual even if strict AI *review* was already on.
Selecting automatic publishing also selects strict AI review and requires a
connected Instagram account. Switching review to manual disables automatic publishing.

Only newly AI-approved drafts generated after activation qualify. Existing drafts,
human-approved drafts, edited drafts, and fitted/white-border layouts are excluded.
Each source must score at least 9/10 and pass the complete-post AI gate. The VPS
then downloads version-checked originals, confirms matching orientation, renders
the saved crop at 1080 pixels wide without upscaling, and strips metadata. A separate
AI call reviews these exact final JPEGs. Their SHA-256 digests are checked against
the staged files before starting the existing durable Instagram publisher.
Rejected preparations return to the human-review queue. Failed/crashed preparations
are never automatically reclaimed. A browser is not required.

Deploy the Worker and all Python files under `scripts/` together, including
`inventory.py`, `preselect.py`, the review modules and the publishing processor. Use the existing
Pillow environment and a one-minute processor timer. The gateway's bounded JPEG
input limit is 1.8 MB per image, matching the publisher. During publication the
processor advances one recorded Meta operation per tick before scanning more
photos. Keep the timer online; this is best-effort processing, not an exact-time
posting scheduler. Scheduled photo discovery is a separate setting.

The limit is **one new automatic attempt per rolling 7 days**, counting manual
publications and failed preparation attempts too. An ambiguous or interrupted
external request stops the queue for owner inspection; it is never blindly retried.
Switching to manual blocks subsequent automatic requests, but cannot recall a
request already sent to Meta. Re-enabling does not resume old automatic attempts.
An in-progress/uncertain publication needs inspection before starting another.
To take over a private prepared draft, select manual mode and regenerate its
publishing preview. Existing expiring delivery links and cleanup remain unchanged.

Automatic mode is opt-in authorization to actually publish. Test your account with
an explicitly approved manual post first. AI is fallible; strict checks reduce
risk but do not guarantee safe or attractive photos. No live automatic post is
part of the repository's automated test suite.

## Private image storage

For larger photo queues, use a private R2 bucket with byte and request limits.
See [R2 setup and safe migration](docs/storage.md). Originals remain in OneDrive.

### Burst preselection and historical catch-up

Upgrade `scripts/preselect.py`, `process_batch.py` and `inventory.py` together.
Using the existing Pillow dependency, the processor filters exact copies and
conservative near-matches within two-minute bursts before AI. It compares two
perceptual hashes, aspect, color and contrast; low-detail images are not merged
by hash alone. The clearest representative in each batch wins, while a much
clearer later image is retained. Different or uncertain views remain for AI.
This heuristic does not guarantee perfect deduplication or aesthetic quality.

Only images actually sent for AI screening consume the analysis limit (300 for
new settings). Acknowledged versions and representative features persist in the
private VPS cache across batches/cycles; the cache contains no image pixels or
tokens. Existing cache records remain valid. Privacy checks, composition review,
original-output review and the seven-day publishing limit remain unchanged.
The best aesthetic score leads each post; ties preserve the editor's cover choice.

Periodic production settings support rolling one/three/six/twelve-month ranges,
all photos, a fixed custom date range, or a start date through the current day.
Save to apply; configuration persists across deployments. A custom start date
supports gradual historical catch-up on the next scheduled run, without sending
the entire archive to AI at once. Existing saved limits are not silently increased.

New manual scans, like scheduled scans, inherit the saved total AI analysis budget
(default 300, configurable from 1 to 1000). The batch size is a separate per-step
limit. See the [deployment security audit](docs/security-audit.zh-CN.md) and
[current privacy boundaries](docs/privacy.md).

See [publication history and repeat protection](docs/publication-history.md) for
the owner statistics page and the limits of historical Instagram coverage.
