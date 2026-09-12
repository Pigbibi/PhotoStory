CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER);
CREATE INDEX IF NOT EXISTS state_expires ON state(expires) WHERE expires IS NOT NULL;
CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, body TEXT NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, data BLOB NOT NULL, mime TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS photo_gc (photo_id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, lease TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs((1)) WHERE status IN ('pending','running');
CREATE TABLE IF NOT EXISTS publications (draft_id TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, version INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS publication_images (publication_id TEXT NOT NULL, photo_id TEXT NOT NULL, data BLOB NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(publication_id,photo_id));
CREATE TABLE IF NOT EXISTS image_objects (
 ref TEXT PRIMARY KEY, object_key TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL,
 digest TEXT NOT NULL, state TEXT NOT NULL, touched INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS storage_totals (id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL, objects INTEGER NOT NULL);
INSERT OR IGNORE INTO storage_totals VALUES(1,0,0);
CREATE TRIGGER IF NOT EXISTS image_objects_added AFTER INSERT ON image_objects BEGIN
 UPDATE storage_totals SET bytes=bytes+NEW.bytes,objects=objects+1 WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS image_objects_removed AFTER DELETE ON image_objects BEGIN
 UPDATE storage_totals SET bytes=bytes-OLD.bytes,objects=objects-1 WHERE id=1;
END;
CREATE TABLE IF NOT EXISTS storage_operations (month TEXT PRIMARY KEY, reads INTEGER NOT NULL, writes INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS legacy_photos ON photos(id) WHERE length(data)>0;
CREATE INDEX IF NOT EXISTS legacy_publication_images ON publication_images(publication_id,photo_id) WHERE length(data)>0;
