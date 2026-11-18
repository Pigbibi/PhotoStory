# Production schedules and retention

English | [简体中文](lifecycle.zh-CN.md)

## Where photos stay

OneDrive originals always remain read-only in OneDrive; PhotoStory never deletes source files. The processor downloads JPEG previews bounded to 768 pixels on the longest edge and strips EXIF/GPS before AI review.

Drafts and approved items live in private Cloudflare D1 (or optionally private R2 per the [storage guide](storage.md)) and require an allowlisted GitHub session to view. No photos, drafts, or keys ever enter this repository.

## Production schedule rules

Under **Connection Settings → Production and Retention Rules**, configure a dedicated source folder, rolling lookback window, weekly or monthly cadence, day, and hour in `Asia/Shanghai`. Scheduled production defaults to disabled; saving shows the next planned timestamp.

Each scheduled trigger first checks maintenance, creates at most one due job inside a single D1 transaction, and advances one bounded scan or AI step. Missed intervals queue at most one catch-up job. Failed jobs never retry automatically and pause scheduled production until inspected.

- By default each scheduled run analyzes up to 100 photos (20 per batch, configurable 1–1000 per job, up to 100 per batch) and generates up to 3–8 drafts per batch, capped by the pending-review threshold.
- Scanned count differs from AI count: unchanged source versions reuse local SQLite deduplication state (including prior exclusions) so already-seen photos do not consume quota again.
- Reaching the analysis limit marks `analysisLimit` complete without pruning unseen older photos; adjust the date range in a manual job if backfilling older ranges.
- Once pending drafts reach the configured threshold (default 20), new batch claims pause until you approve or trash existing drafts.
- Drafts default to manual human review; enabling **Strict AI auto-review** applies only to subsequent jobs. Automatic publishing remains independent and disabled by default.

## Trash and cleanup

Pending and approved drafts never auto-expire. Discarded drafts enter trash for 30 days, during which you can restore them to pending review (without restoring prior approval). Version checks prevent stale tabs from overwriting newer edits.

Daily maintenance runs after 04:00 to purge expired trash items. A preview image is deleted only when zero remaining drafts (including trash) reference it. Removing a photo from a draft during editing grants that preview a matching 30-day retention window.

Ordinary worker directories and temporary JPEGs are cleaned immediately when each AI call finishes. On optional systemd hosts, `photostory-cleanup.timer` runs daily at 04:20 to sweep stale files older than 24 hours inside fixed directories without touching SQLite inventories or unrelated host paths.

Private SQLite inventory metadata does not auto-expire because clearing it loses deduplication history and resume pointers.

## Upgrading deployments

1. Disable or pause active processor triggers and wait for any running batch to finish cleanly.
2. Apply any additive schema SQL (such as `worker/schema.sql` or `worker/storage-schema.sql`) before deploying the updated Worker.
3. Deploy the Worker, frontend build, and Python `scripts/` together after verifying tests.
4. Confirm retention settings and run one small bounded scan before re-enabling schedules.
