# Private R2 image storage

PhotoStory can store previews and final publishing JPEGs in a private Cloudflare
R2 Standard bucket. Original photos remain in OneDrive. D1 retains draft text,
settings, approval versions, source mappings, publication history and object
metadata; it no longer needs to hold image bytes after migration.

## Enable on an existing deployment

1. Export D1 to a private backup before changing storage. The backup contains
   private photos and encrypted connection records; never commit or share it.
2. Enable R2 in your Cloudflare account if needed. Review its billing terms:
   [official pricing](https://developers.cloudflare.com/r2/pricing/).
3. Create a dedicated bucket with `npx wrangler r2 bucket create photostory-media`.
   Keep Standard storage and public access disabled. Do not enable `r2.dev`, add a
   public custom domain, or upload unrelated files to this bucket.
4. Apply `worker/storage-schema.sql` to the existing D1 database. For a new site,
   `worker/schema.sql` already includes these tables, indexes and triggers.
   Example: `npx wrangler d1 execute photostory --remote --file worker/storage-schema.sql`.
   Use your own database name and local configuration file when applicable.
5. Add this binding to your Wrangler configuration:
   ```json
   "r2_buckets": [{"binding": "MEDIA_BUCKET", "bucket_name": "photostory-media"}]
   ```
   Set `MEDIA_STORAGE=r2` in Worker vars so removing the binding stops uploads
   instead of silently switching new writes to D1. No S3 access keys are required.
6. Build and deploy. In Connection Settings, use **Migrate existing previews**.
   Each click migrates up to ten previews and eight unexpired publishing images.
   Repeat until the remaining preview count is zero. The authenticated machine
   endpoint `POST /internal/storage/migrate` offers the same bounded operation.
7. Check the private preview page, legacy byte counts and R2 statistics. Migration
   does not change draft content, approvals, publishing mode or OneDrive originals.

The Worker copies each image, reads it back and verifies SHA-256 before clearing
only the matching old D1 bytes. A failed verification leaves D1 intact. Repeating
completed batches does not upload another copy. Empty D1 bytes mean an R2 reference,
not an empty image. Removing the R2 binding after migration does not restore D1
images; keep the bucket and binding or restore a verified private backup.

## Capacity and request safeguards

These Worker vars have conservative defaults and can be lowered in deployment
configuration. They are not secrets:

| Variable | Default | Maximum allowed |
| --- | --- | --- |
| `STORAGE_MAX_BYTES` | 8,000,000,000 (8 GB) | 8,000,000,000 |
| `STORAGE_WRITE_LIMIT` | 100,000/month | 1,000,000 |
| `STORAGE_READ_LIMIT` | 1,000,000/month | 10,000,000 |

The settings page shows reserved/used bytes and application R2 request counts,
with a warning at 80%. D1 atomically reserves space before each upload; concurrent
uploads cannot each claim the same remaining capacity. Reaching a limit stops new
work. The monthly request budget resets by UTC calendar month. If the read limit
is reached, image retrieval temporarily stops too; stored photos are not deleted.
Counters conservatively count attempted operations, including failed attempts.

These limits only cover this PhotoStory installation. **They are not Cloudflare
account-wide spending caps or a guarantee of a zero bill.** Other buckets,
operations made outside the app and other Cloudflare services are excluded.
Check the account billing dashboard and leave headroom for other applications.
The free tier is shared, usage-based, and subject to Cloudflare's current terms.

## Privacy, cleanup and interrupted operations

- Owner-authenticated Worker routes serve previews; bucket addresses are not
  exposed. Instagram receives only the existing temporary delivery route after
  publishing starts. Expired or unstarted deliveries remain inaccessible.
- Referenced pending/approved previews have no expiration. Existing 30-day trash
  retention remains in force; OneDrive originals are never removed.
- Expired publishing JPEGs are removed by the existing maintenance timer.
  Unreferenced ready uploads have a 24-hour grace period to protect pending D1
  transactions. Cleanup requires the background timer to be online.
- An uncertain R2 PUT retains its capacity reservation and is not automatically
  retried or deleted. This favors preserving data over silently understating
  usage. An operator must inspect its object and hash before reconciling it.
- Failed DELETE operations retain their reservation until an idempotent deletion
  succeeds. Successful R2 deletion precedes releasing D1 capacity.
- Do not modify this bucket manually or add a lifecycle rule that expires all
  objects: external changes bypass application counters and retention rules.

Deployments without an R2 binding retain the original D1 storage behavior. New
migration code must remain deployed after clearing legacy bytes. To roll back,
first restore the private D1 backup or retain R2-aware image reads.
