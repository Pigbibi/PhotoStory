# Publication history and repeat protection

Open **Publication history** after signing in. Two counters have different meanings:

- **PhotoStory history** counts successful publication records, photo placements,
  and unique OneDrive source IDs. Records survive temporary-image cleanup and
  posts deleted directly in Instagram. They are not the current profile count.
- **Instagram inventory** reads the connected account's media through the official
  API, 25 posts per click, including every image child in a carousel. Continue until
  **Inventory complete**. Videos are not counted as photos. Previously observed
  records are retained even if a later inventory no longer contains them. Starting
  another pass refreshes the inventory; it does not delete the earlier records.

The owner-only sync endpoint uses the existing basic Instagram permission and
stores only media IDs, publication dates, image counts and pagination progress in
private D1. It does not download photos, store provider URLs, send old posts to AI,
change permissions or publish anything. Tokens remain server-side. A failed or
partial carousel response is not accepted as a complete inventory.

PhotoStory source IDs from published, in-progress or uncertain publication records
are excluded from new scans. The publication-start guard rejects a source already
used in another such record, even if the preview was cleaned up. This protects the
same OneDrive item; making a new file copy creates a different source ID.

**An Instagram media ID is not a OneDrive source ID.** Imported historical posts
are counted and can now enter a bounded visual-match proposal pass. During a
normal processor scan, one small page of old Instagram image media is held in
VPS memory, reduced to a local `dhash-v1` fingerprint, and discarded. Current
OneDrive previews are fingerprinted the same way. Only proposals are stored;
provider URLs and image bytes are not stored in D1. A proposal never excludes a
source by itself: review and confirm it in Publication history first. A failed
or incomplete pass leaves the source eligible. Keep a known-new date range until
the historical inventory and matching pass are complete; do not enable
whole-library automatic publishing on the assumption that unconfirmed proposals
guarantee no repeats. Existing conservative burst filtering is separate and is
not historical Instagram matching.

Matching proposals are created only after the private Instagram inventory is
complete. Read the next Instagram history page until **Inventory complete**;
the processor then advances the old-media hash page by a bounded amount per
normal job. A large account may therefore take several scans. The media URL is
available only to the machine-authenticated processor and is never shown in the
browser.

The inventory response also includes `instagram.matchCoverage` and a separate
`matching` object. In the current
`metadata_only` mode, a record is marked `photostory_post` only when its
Instagram media ID (or carousel child ID) is present in PhotoStory's own
publication ledger; other records are `unmatched`. `sourceMatches` increases
only after the owner confirms a stored proposal. The owner-only
`POST /api/history/matches/confirm` endpoint accepts only proposals created by
the machine-authenticated processor. The coverage percentage therefore means
verified source matches, not the number of posts inventoried.

**Run history-only verification** is a read-only follow-up task. It uses the saved periodic-production folder and date range (or the most recent completed task when no periodic range is saved) and revisits every matching OneDrive photo, including photos that were already screened by AI. Each bounded processor step handles at most 100 photos, computes only local visual fingerprints, and never calls AI, creates drafts, or publishes to Instagram. Large libraries therefore finish over several scheduled steps; progress is visible in the task list and failures are not retried automatically. Results remain proposals until the owner confirms them.

For hands-off production, select **Strict AI auto-review** and **Strict AI automatic publishing** in Production and Retention Rules. New drafts that pass the strict review can then publish under the low-frequency guard, subject to a connected Instagram account and the configured limits. This mode does not auto-confirm historical visual matches: keeping that confirmation owner-controlled prevents a similar-looking landscape from permanently excluding the wrong source.
