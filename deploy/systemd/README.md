# Isolated Linux processor

These units separate the trusted OneDrive scanner (`photostory`) from the model
(`photostory-ai`). They require systemd 255 or newer, Python 3.12, a separately
installed Codex CLI supporting the flags in `runtime/bin/codex`, and (only for `aigateway-cli` mode) a compatible
local gateway at `/opt/codex-gateway`. The gateway is supplied by the deployer;
this public repository contains no private gateway code or credentials.

Use a shared system group `photostory-bridge` and two system users without login
shells. Install the repository's `scripts`, `runtime`, and `deploy` directories
under `/opt/photostory/app`, owned by root and not writable by either service user.
Create a Python venv at `/opt/photostory/venv` and install
`scripts/requirements.txt` from `https://pypi.org/simple`.

Create the following directories (owner / group / mode):

| Path | Owner | Group | Mode |
| --- | --- | --- | --- |
| `/var/lib/photostory-ai` and its `codex` subdirectory | photostory-ai | photostory-bridge | 0700 |
| `/var/lib/photostory-bridge` | root | root | 0755 |
| `/var/lib/photostory-bridge/input` | photostory | photostory-bridge | 0750 |
| `/var/lib/photostory-bridge/output` | photostory-ai | photostory-bridge | 0750 |
| `/etc/photostory` | root | root | 0700 |

Provision `/etc/photostory/processor.env` as root-owned 0600, containing
`PHOTOSTORY_URL` and `PHOTOSTORY_BATCH_TOKEN`. Generate a new random machine token
and store the matching value as the Worker's `BATCH_TOKEN` secret through a secure
input mechanism. Never paste actual values into shell arguments or this repository.

For a new deployment, log in to Codex as `photostory-ai` with
`HOME=/var/lib/photostory-ai` and `CODEX_HOME=/var/lib/photostory-ai/codex`.
Do not copy another service's OAuth refresh tokens: independent login avoids
sharing token rotation state. The account still shares its subscription limits.

Validate the units with `systemd-analyze verify`, and `photostory.sudoers` with
`visudo -cf`. Install the units under `/etc/systemd/system` and the sudoers file
as root-owned 0440 under `/etc/sudoers.d/photostory`. Reload systemd. The sudoers
entry permits the scanner to start **only** the fixed AI unit; the AI user has no
such privilege. Do not add wildcard arguments or allow arbitrary transient units.

After verifying isolation and Codex login, create one job in the website, then run
`sudo systemctl start photostory-batch.service`. One invocation handles one job.
Nothing is scheduled automatically by these files.

## Boundaries and verification

- The AI unit hides host home directories and masks `/opt`, `/var`, `/run`, and
  `/etc`, exposing only the listed code, TLS/DNS configuration, input, and its own
  state/output directories. The input bind mount is read-only. Other process
  details are hidden; no Graph or machine credentials are in the AI environment.
- The launcher disables shell, browser, MCP configuration, apps, and other tool
  features; user configuration/rules and persistent sessions are disabled. These
  flags are version-sensitive: reverify when upgrading Codex. The service still
  has outbound networking for Codex authentication and inference; this is **not**
  an outbound destination allowlist. The Codex client itself can read its own
  dedicated authentication state.
- Inputs are bounded regular files, with symlinks rejected. Each response must
  match the current random request ID. The scanner serializes calls and cleans
  mailbox inputs on success and handled failure. AI working directories are
  removed on normal exit. Abrupt host/process termination can leave temporary
  files; inspect and clean PhotoStory's own directories before recovery. The
  output mailbox retains the latest structured result until the next call.
- Verify the effective namespace using harmless probes before supplying photos:
  non-root UID, unreadable `/home/ubuntu` and scanner secrets, read-only inbox,
  writable AI output, accepted Codex flags, and working TLS/DNS. A successful
  local unit test does not establish these deployed boundaries.
- Do not relax the host's AppArmor or other existing service protections to make
  Codex tool sandboxes work. Keep the existing shared gateway service unchanged.
- AI screening can miss private details. Human review and disabled IG publishing
  remain the default.

## Reusing an existing gateway login

An administrator may add a **private** systemd drop-in with
`Environment=PHOTOSTORY_AI_MODE=aigateway-cli` and
`LoadCredential=codex-auth:/ABSOLUTE/PATH/TO/EXISTING/auth.json`.
Systemd reads that file without changing its ownership or permissions. The runner
creates a per-call private auth snapshot containing the current access/identity
tokens, an empty refresh token, and no unrelated fields. That snapshot is removed
with the working directory. The original service remains responsible for its
login and refresh lifecycle. A token with less than 650 seconds remaining fails
before model invocation; PhotoStory never refreshes or rewrites the shared login.
The systemd credential itself exists only for the AI unit lifetime and is visible
to the trusted client runtime, whose model tools are disabled.

This option requires a current ChatGPT OAuth login in the expected Codex format;
it does not support arbitrary gateway API keys. Test a harmless image before
supplying private photos. If the existing service does not maintain current auth,
use a dedicated login or repair its normal credential lifecycle; do not start
copying refresh tokens or bypassing authentication.

If the existing gateway source is owner-only, do not widen access to its whole
installation. Install just its launcher and Python implementation into a private,
root-owned code directory readable by `photostory-bridge`; bind that directory
read-only into the AI unit and set `PHOTOSTORY_GATEWAY_PATH` to its launcher.
This path is administrator configuration, never model input. Keep private gateway
code outside the public PhotoStory checkout, and track upgrades separately.
