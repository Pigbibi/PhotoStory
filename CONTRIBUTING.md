# Contributing

Thanks for taking a look. This is a single-owner project, so the fastest path is a small, focused pull request rather than a large refactor.

## Before you start

Open an issue first if your change touches any of these — they are easier to discuss before code exists:

- The publishing path, approval state machine, or anything that can send a post to Instagram
- The Worker's authentication or the `ALLOWED_GITHUB_USERS` check
- The D1 schema
- What the processor is allowed to receive (tokens, previews, EXIF)

Small fixes — typos, broken links, a failing test, an obviously wrong condition — can go straight to a pull request.

## Setup

```sh
npm ci
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
```

Copy `wrangler.jsonc` to `wrangler.local.jsonc` for any local Worker work. That file is git-ignored and must stay that way.

## Checks

Run all of these before opening a pull request:

```sh
npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
npm run build
```

The Node tests and the Python tests are independent; both need to pass.

## What a good pull request looks like

- One concern per pull request. A schema change and a UI tweak are two pull requests.
- The description says what breaks without the change, not just what the change does.
- New behaviour comes with a test. If it can't be tested without a live Microsoft or Instagram account, say so and describe how you verified it manually.
- If you change a boundary described in the README or in `docs/`, update that text in the same pull request. Stale boundaries are worse than missing ones.

## Code expectations

- The Worker, the processor, and the frontend are separate trust domains. Don't move logic across them to save a file.
- Treat model output, image text, and metadata as untrusted data. Never let them become instructions or SQL.
- The processor must not gain access to OneDrive refresh tokens, Worker secrets, or publishing authority. A change that needs one of those is a design discussion, not a patch.
- Frontend code never infers a review flag from an image or caption. Flags come from stored records.

## Commits

Write commit messages that explain the change in a sentence a reader can follow:

```text
fix: keep the approval record when a reorder invalidates it
docs: correct the R2 lifecycle rule in storage.md
```

## Licence

Contributions are accepted under the [MIT licence](LICENSE) that covers this repository.
