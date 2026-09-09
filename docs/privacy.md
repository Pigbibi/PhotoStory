# Privacy and operating limits

Thumbnail downloads allow HTTPS Microsoft image hosts, including regional
`<region>-mediap.svc.ms` hosts returned by Graph. Microsoft documents `*.svc.ms`
in its [OneDrive endpoint list](https://learn.microsoft.com/en-us/microsoft-365/enterprise/urls-and-ip-address-ranges?view=o365-worldwide).
The scanner admits only the media subfamily, rejects unexpected ports and URL
credentials, blocks redirects, and never forwards a Graph token to thumbnail URLs.

The public website shell is not an authentication boundary. Every private API and
photo response checks a server-side session. Sessions are random, HttpOnly, Secure,
SameSite=Lax cookies backed by expiring D1 records. The configured username allowlist
is rechecked on every request. State-changing browser calls require the same Origin.
OAuth state is bound to the initiating browser and consumed once, with PKCE.

The trusted VPS batch token is a separate machine credential. It can claim jobs,
obtain Graph access tokens for processing and import drafts. It cannot be given to
browser code, a public workflow, an untrusted plugin or a model subprocess. Rotate
it in both the Worker and VPS if exposed. Do not copy other projects' credentials.

Microsoft access/refresh tokens are encrypted with AES-GCM in D1. The encryption
key stays in Worker Secrets. GitHub access tokens are used only for the identity
lookup and are not persisted. The implementation requests no repo scope.

PhotoStory stores selected JPEG review previews and draft text in the configured
languages. Pending and approved drafts are retained; trash and unreferenced previews
follow the configurable retention policy described in the README.
There is no public photo URL or publishing route. Approved originals can be
exported through an authenticated, same-origin, version-checked POST route. All
responses use no-store and private routes do not accept third-party origins.
Do not enable analytics or request-body logging for private payloads.

AI safety classification is fallible. The prompt conservatively excludes private
interiors, documents, identifiable people/children, sexual imagery, personal details
and uncertain images. It cannot guarantee every sensitive detail will be detected.
Only 768px-or-smaller previews are screened, which can hide small details; uncertainty
must be rejected. Manual review is the default. Strict AI auto-review can be enabled explicitly for
new jobs; its additional pass is fallible and does not guarantee privacy. It never
publishes. Changing the reviewed content revokes approval. See the README for gates.

The scanner does not claim complete library analysis. It skips videos, screenshots
identified by filename, remote shortcuts, and photos without an explicit capture
timestamp. GPS is rounded to 0.1-degree cells before persistence or model input;
exact GPS is never stored or used as a caption location. Time gaps and coarse
spatial separation split candidate groups; visual themes further refine drafts.
At most 24 screened candidates per batch enter the composition pass. Other photos
are unselected, not deleted. Identical preview bytes and previously imported photo
IDs are deduplicated; perceptual near-duplicates rely on the model and reviewer.

Model text, file metadata and image text are untrusted. Prompts prohibit executing
instructions found inside them. The gateway is restricted to its read-only path;
the model is not granted publishing permission. Use a dedicated trusted runtime
and the gateway's existing credential isolation. This repo does not broaden the
gateway's repository/ref permissions or disable authentication.

One job may be active at a time. Large ranges are divided into metadata and AI
steps, each with a new lease. The optional VPS timer continues pending steps, not
failed calls. New scans are created only by the owner or an explicitly enabled
weekly/monthly schedule. It never publishes photos. Owners can stop
subsequent steps; a currently running batch is allowed to finish. Requests are not
automatically retried. If a
completion upload has an uncertain result, the worker leaves the job for readback
instead of resending or marking it safely failed. A process crash can leave a job
running; an operator must inspect that exact job before recovery. Do not clear a
running job while its VPS process may still be operating.

Changing an approved draft's caption, tags, theme or photo order invalidates its
approval; the next approval must target the saved version. Even an approved draft
does not trigger any public action in v0.1.

OAuth starts require the configured AUTH_LIMITER binding and are limited to 20 per minute per Cloudflare location using a fixed key. This mitigates abuse but is not a global hard quota. Expired authentication records are removed in bounded batches on later auth writes. Live sessions and encrypted Microsoft tokens are preserved.

The model subprocess receives only allowlisted environment values and uses local Codex. HOME/CODEX_HOME and the runtime filesystem must be dedicated and restricted; environment filtering does not make host files unreadable. Complete that deployment check before providing real photos.

Private VPS SQLite files retain candidate IDs, capture times, coarse location,
paging cursors and processed version/preview hashes; no image bytes or model
captions are stored in this inventory. This metadata has no automatic retention
purge. The shared processed cache includes exclusions to avoid repeated analysis.
It is keyed by source version and policy revision; files without version metadata
cannot be reliably reused across jobs. Clearing the cache can cause reanalysis.
All timestamps are interpreted using the selected deployment's documented
Asia/Shanghai date boundaries; dates without a timezone are not guessed.

A committed batch ID is saved with drafts in D1. If a response is lost after a
successful commit, the next claimed step reconciles that ID before updating local
processed state; it does not call the model again for that acknowledged batch.
A pending local AI batch with no matching remote acknowledgement stops instead.
Do not expose the inventory directory to the AI service. The default batch limit
is a per-step resource limit, not a monthly cost or total-library analysis limit.

Scheduled jobs have an additional total analysis limit (default 100) and stop when
it is reached. The pending-review threshold pauses future claims, with an already
running batch allowed to finish. Review and approved drafts do not expire.
Trash is recoverable for 30 days; cleanup checks every remaining draft reference
before deleting preview bytes. Editing a photo out also schedules a 30-day grace
period. Cleanup and restore transactions cannot leave a restored draft without its
preview. The daily VPS residue cleaner checks the owner switch and service state,
holds the mailbox lock, skips symlinks, and only removes fixed PhotoStory temporary
targets older than 24 hours. It never clears the inventory or Codex login directory.
See [full retention behavior](lifecycle.zh-CN.md).

Interface language preferences store only a language code in browser localStorage.
Draft framing stores a canvas ratio and per-photo mode/position in private D1,
not new public images. It never modifies OneDrive originals. Original exports
pass transiently through Worker/browser memory, are capped at 25 MB/50 megapixels,
and are encoded to new JPEGs without source EXIF/GPS metadata. Downloaded ZIPs are
local files under the owner’s control and are not covered by website trash cleanup. Interface translation
catalogs are static public strings; private draft text is not sent for translation
when the user switches the interface language.

## Optional Instagram connection

The owner can authorize the configured Instagram professional account. The Worker
verifies its username, account type, identity and required basic/publishing scopes,
then encrypts the access token in D1 with the existing encryption key. Only the
verified username and stored expiry are displayed to the owner. Tokens, client
secrets, authorization codes and provider errors are not returned in frontend API
responses or sent to AI. Meta's token exchange uses private server requests; do not enable request-URL
logging for those requests. Tokens are not refreshed automatically in this release.
Revocation is managed in Instagram's Apps and websites settings. No photos or
captions are uploaded to Instagram by connecting, and publishing remains disabled.
