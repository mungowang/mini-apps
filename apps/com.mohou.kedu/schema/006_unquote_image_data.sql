-- 004 copied kv values as raw column text. A kv string is stored JSON-quoted,
-- so migrated data rows carry wrapping double quotes and <img src> sees
-- "data:…" (a broken url). A data url never contains a quote, so cut the
-- first and last character of exactly those rows. Rows added at runtime
-- after 004 never have them.

UPDATE task_images
SET data = substr(data, 2, length(data) - 2)
WHERE data IS NOT NULL
  AND substr(data, 1, 1) = '"'
  AND substr(data, length(data), 1) = '"';

CREATE TABLE _img_unquote_check (
  label TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
);

INSERT INTO _img_unquote_check (label, ok)
SELECT 'no_quoted_rows',
  CASE WHEN (SELECT COUNT(*) FROM task_images
      WHERE data IS NOT NULL AND substr(data, 1, 1) = '"') = 0 THEN 1 ELSE 0 END;

INSERT INTO _img_unquote_check (label, ok)
SELECT 'data_still_present',
  CASE WHEN (SELECT COUNT(*) FROM task_images WHERE data IS NULL) = 0 THEN 1 ELSE 0 END;

DROP TABLE _img_unquote_check;
