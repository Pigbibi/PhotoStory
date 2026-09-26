# PhotoStory

[简体中文](README.zh-CN.md)

PhotoStory is an open-source, self-hosted photo curation desk for one private
photo workflow. It reads a bounded part of a OneDrive library, turns suitable
scenery into editable drafts, and keeps review and publishing under the owner's
control.

The repository contains no photos, accounts, tokens, database exports, or hosted
AI service. You deploy your own Worker, D1 database, OneDrive connection, and
optional VPS processor.

![Interface design concept](docs/design-concept.png)

## What it does

- Screens bounded OneDrive photo ranges for privacy, people, composition, and
  scenic suitability before drafting.
- Groups photos by capture time, coarse area, orientation, and visual scene.
  It distinguishes daylight, golden hour, blue hour, and night. A city or public
  landmark is named only when the visual evidence is high confidence.
- Creates editable titles, captions, hashtags, crop framing, and carousel order.
- Keeps originals in OneDrive. Review previews are EXIF-free and private.
- Supports manual publishing to a configured Instagram professional account.
  Strict AI review and low-frequency automatic publishing are separate opt-in
  settings; manual approval and manual publishing are the defaults.
- Stores publication records and offers owner-confirmed historical matching to
  avoid reusing the same source photo.

## Ownership and data isolation

PhotoStory is a single-owner workflow, not a multi-tenant service. One deployment
has one private D1 database and one shared set of drafts, settings, publication
history, and curation preferences. If you allow more than one GitHub account into
the same deployment, those administrators share that data.

Different deployments do not exchange photos, settings, prompts, or preferences.
For separate people or organizations, deploy separate instances with separate
Cloudflare resources and credentials.

Owner preference signals are deliberately small and instance-local:

- Removing a photo from a saved carousel records that the owner prefers a tighter
  visual subject in future grouping.
- Approving a draft that strict review rated lower on a soft quality criterion
  records only that aggregate quality signal.
- These signals help rank otherwise safe drafts. They never relax privacy,
  location, approval, or publishing checks, and they do not train a shared model.

Read [ownership and preferences](docs/ownership-and-preferences.md) before using
the feature with more than one administrator.

## Architecture

```text
Browser → Cloudflare Worker + D1 (+ optional private R2)
                         ↕ machine-authenticated API
                 trusted VPS processor → isolated AI runtime
                         ↕
                      OneDrive and Instagram
```

The Worker owns authentication, OAuth, settings, drafts, approval state, and
publication state. The VPS performs bounded scans and model calls. The AI runtime
does not receive OneDrive refresh tokens, Worker secrets, or publishing authority.
The processor receives EXIF-free previews; it never deletes OneDrive originals.

## Quick start

Requirements: Node.js and npm, Python 3 with Pillow, a Cloudflare account, a
GitHub OAuth App, and a Microsoft Entra app that supports personal Microsoft
accounts. The processor also needs an authenticated Codex CLI or a compatible
local AIGateway CLI on a trusted Linux host.

```sh
npm ci
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
cp wrangler.jsonc wrangler.local.jsonc
npx wrangler d1 create photostory
```

Edit the ignored `wrangler.local.jsonc` before deploying:

1. Give the Worker and D1 database unique names.
2. Replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`.
3. Set `ALLOWED_GITHUB_USERS` to the exact GitHub usernames that may administer
   this instance. Do not use a wildcard.
4. Create an account-specific `AUTH_LIMITER` namespace and replace the example
   namespace ID.

```sh
npx wrangler d1 execute photostory --remote --file worker/schema.sql --config wrangler.local.jsonc
npm run deploy
```

`npm run preview` and `npm run deploy` intentionally use
`wrangler.local.jsonc`, not the public template. A copied repository cannot target
another deployment until you create that local configuration.

## Configure authentication and storage

Use Cloudflare's interactive secret input. Do not place secrets in a command
history, source file, frontend variable, issue, screenshot, or chat.

| Setting | Where it belongs | Purpose |
| --- | --- | --- |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Worker Secrets | Owner sign-in |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Worker Secrets | OneDrive consent |
| `TOKEN_ENCRYPTION_KEY` | Worker Secret | 32-byte base64 AES-GCM key for Microsoft tokens |
| `BATCH_TOKEN` | Worker Secret | Authenticates the VPS processor |
| `PHOTOSTORY_BATCH_TOKEN` | private VPS environment | Same machine token |
| `PHOTOSTORY_URL` | private VPS environment | Your Worker origin |
| `CODEX_GATEWAY_COMMAND` | private VPS environment | Your AI CLI adapter |

Register these redirects with your own applications:

```text
https://YOUR-SITE/auth/github/callback
https://YOUR-SITE/auth/microsoft/callback
```

GitHub login requests no repository scope. Microsoft consent requests read access
and offline access; the processor applies the selected folder and date range.
The full setup is in [AI and VPS setup](docs/ai-setup.zh-CN.md).

## Run the workflow

1. Sign in with an allowed GitHub account and connect OneDrive.
2. Select a folder and bounded capture-date range in the website.
3. Run the processor on the trusted VPS. Each invocation handles one bounded
   metadata or AI step.
4. Inspect every draft. You may edit text, order, photos, and framing; an edit
   invalidates prior approval.
5. Approve a draft. In manual mode, prepare its final JPEGs and explicitly publish
   it to the connected account. Exporting a ZIP never publishes.

The optional timer advances pending work only while it is online. It does not
retry failed or uncertain external operations automatically. See
[lifecycle and retention](docs/lifecycle.zh-CN.md).

## Safety boundaries

- Model output, image text, and metadata are untrusted data, never instructions.
- Unknown or uncertain screening results do not become drafts.
- Exact GPS is not stored or used in captions. Place names need visible public
  evidence or an unmistakable public landmark.
- AI review is fallible. It is not a privacy guarantee and never grants publishing
  permission on its own.
- Instagram publication can have an uncertain external result. PhotoStory retains
  the record for readback rather than replaying a possibly successful request.

See [privacy and operating limits](docs/privacy.md),
[Instagram setup](docs/instagram-setup.md), and
[publication history](docs/publication-history.md) for the detailed contracts.

## Documentation

- [AI and VPS setup](docs/ai-setup.zh-CN.md)
- [Ownership and preferences](docs/ownership-and-preferences.md)
- [Privacy and operating limits](docs/privacy.md)
- [Lifecycle and retention](docs/lifecycle.zh-CN.md)
- [Instagram setup](docs/instagram-setup.md)
- [Publication history and repeat protection](docs/publication-history.md)
- [Private R2 storage](docs/storage.md)
- [Security design and deployment checks](docs/security-audit.zh-CN.md)
- [Linux processor isolation](deploy/systemd/README.md)

## Validation

Run the Node tests, Python tests, and production build before deploying:

```sh
npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
npm run build
```

These checks validate the repository behavior. OAuth consent, OneDrive access,
your AI runtime, and Instagram publishing still need a controlled test in your
own deployment.

## License

[MIT](LICENSE)
