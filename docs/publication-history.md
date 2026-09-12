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
are counted but are not yet matched to originals. Cross-platform visual matching
of compressed/cropped images is not implemented. Keep a known-new date range until
that match coverage is available; do not enable whole-library automatic publishing
on the assumption that these counters guarantee no repeats. Existing conservative
burst filtering is separate and is not historical Instagram matching.
