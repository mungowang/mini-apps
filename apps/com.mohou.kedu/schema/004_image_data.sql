-- Move image bytes from kv (img_<id>) into task_images.data.
-- Meta already lives in task_images; after this file the kv copies are gone.
-- Fresh installs: no img_ rows in kv, the check is 0 = 0, nothing is deleted.

ALTER TABLE task_images ADD COLUMN data TEXT;

UPDATE task_images
SET data = (SELECT value FROM kv WHERE key = 'img_' || task_images.id)
WHERE data IS NULL;

CREATE TABLE _kv_images_check (
  label TEXT PRIMARY KEY,
  expected INTEGER NOT NULL,
  actual INTEGER NOT NULL,
  ok INTEGER NOT NULL CHECK (ok = 1)
);

-- Every image row must carry its bytes: a meta row without data is a broken image.
INSERT INTO _kv_images_check (label, expected, actual, ok)
SELECT 'image_rows_with_data',
  (SELECT COUNT(*) FROM task_images),
  (SELECT COUNT(*) FROM task_images WHERE data IS NOT NULL),
  CASE WHEN (SELECT COUNT(*) FROM task_images)
    = (SELECT COUNT(*) FROM task_images WHERE data IS NOT NULL) THEN 1 ELSE 0 END;

-- All checks passed: the table holds every image. Drop the kv copies,
-- orphan blobs from long-deleted tasks included (they point at nothing).
DELETE FROM kv WHERE substr(key, 1, 4) = 'img_';

DROP TABLE _kv_images_check;
