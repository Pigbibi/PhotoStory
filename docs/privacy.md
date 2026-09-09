# Privacy and operating limits

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

PhotoStory stores selected JPEG review previews and English draft text until the
deployment owner removes them. There is no automatic retention purge in v0.1.
There is no public photo URL or original-image download/publishing route. All
responses use no-store and private routes do not accept third-party origins.
Do not enable analytics or request-body logging for private payloads.

AI safety classification is fallible. The prompt conservatively excludes private
interiors, documents, identifiable people/children, sexual imagery, personal details
and uncertain images. It cannot guarantee every sensitive detail will be detected.
Only 768px-or-smaller previews are screened, which can hide small details; uncertainty
must be rejected. Human review remains the final decision.

The scanner does not claim complete library analysis. It skips videos, screenshots
identified by filename, remote shortcuts, and photos without an explicit capture
timestamp. It ignores exact GPS to avoid leaking private locations into captions.
It selects at most 24 screened candidates for the composition pass. Other photos
are unselected, not deleted. Identical preview bytes and previously imported photo
IDs are deduplicated; perceptual near-duplicates rely on the model and reviewer.

Model text, file metadata and image text are untrusted. Prompts prohibit executing
instructions found inside them. The gateway is restricted to its read-only path;
the model is not granted publishing permission. Use a dedicated trusted runtime
and the gateway's existing credential isolation. This repo does not broaden the
gateway's repository/ref permissions or disable authentication.

One job may be active at a time. Requests are not automatically retried. If a
completion upload has an uncertain result, the worker leaves the job for readback
instead of resending or marking it safely failed. A process crash can leave a job
running; an operator must inspect that exact job before recovery. Do not clear a
running job while its VPS process may still be operating.

Changing an approved draft's caption, tags, theme or photo order invalidates its
approval; the next approval must target the saved version. Even an approved draft
does not trigger any public action in v0.1.

OAuth starts require the configured AUTH_LIMITER binding and are limited to 20 per minute per Cloudflare location using a fixed key. This mitigates abuse but is not a global hard quota. Expired authentication records are removed in bounded batches on later auth writes. Live sessions and encrypted Microsoft tokens are preserved.

The model subprocess receives only allowlisted environment values and uses local Codex. HOME/CODEX_HOME and the runtime filesystem must be dedicated and restricted; environment filtering does not make host files unreadable. Complete that deployment check before providing real photos.
