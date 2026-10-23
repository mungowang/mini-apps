-- Migrate the old single-blob kv row (key = 'tasks') into the task tables.
-- No-op on fresh installs: there is no 'tasks' row in kv.
-- The whole file is one transaction; a bad row fails the batch and nothing is written.

INSERT INTO tasks (
  id, title, notes, done, priority, starts, due, start_time, end_time,
  sort_order, created_at, completed_at, doing, doing_at
)
SELECT
  json_extract(e.value, '$.id'),
  COALESCE(json_extract(e.value, '$.title'), ''),
  COALESCE(json_extract(e.value, '$.notes'), ''),
  CASE WHEN COALESCE(json_extract(e.value, '$.done'), 0) = 1 THEN 1 ELSE 0 END,
  CASE WHEN json_extract(e.value, '$.priority') BETWEEN 1 AND 4
    THEN json_extract(e.value, '$.priority') ELSE 3 END,
  json_extract(e.value, '$.starts'),
  json_extract(e.value, '$.due'),
  json_extract(e.value, '$.startTime'),
  json_extract(e.value, '$.endTime'),
  COALESCE(json_extract(e.value, '$.order'), 0),
  COALESCE(json_extract(e.value, '$.createdAt'), CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  json_extract(e.value, '$.completedAt'),
  CASE WHEN COALESCE(json_extract(e.value, '$.done'), 0) = 1 THEN 0
    WHEN COALESCE(json_extract(e.value, '$.doing'), 0) = 1 THEN 1 ELSE 0 END,
  CASE WHEN COALESCE(json_extract(e.value, '$.done'), 0) = 0
      AND COALESCE(json_extract(e.value, '$.doing'), 0) = 1
    THEN json_extract(e.value, '$.doingAt') ELSE NULL END
FROM kv, json_each(kv.value) AS e
WHERE kv.key = 'tasks' AND json_type(e.value) = 'object';

INSERT INTO task_tags (task_id, tag)
SELECT json_extract(e.value, '$.id'), t.value
FROM kv, json_each(kv.value) AS e, json_each(e.value, '$.tags') AS t
WHERE kv.key = 'tasks';

INSERT INTO task_subtasks (id, task_id, pos, title, done, completed_at)
SELECT
  json_extract(s.value, '$.id'),
  json_extract(e.value, '$.id'),
  s.key + 1,
  COALESCE(json_extract(s.value, '$.title'), ''),
  CASE WHEN COALESCE(json_extract(s.value, '$.done'), 0) = 1 THEN 1 ELSE 0 END,
  json_extract(s.value, '$.completedAt')
FROM kv, json_each(kv.value) AS e, json_each(e.value, '$.subtasks') AS s
WHERE kv.key = 'tasks';

INSERT INTO task_images (id, task_id, pos, w, h)
SELECT
  json_extract(i.value, '$.id'),
  json_extract(e.value, '$.id'),
  i.key + 1,
  COALESCE(json_extract(i.value, '$.w'), 0),
  COALESCE(json_extract(i.value, '$.h'), 0)
FROM kv, json_each(kv.value) AS e, json_each(e.value, '$.images') AS i
WHERE kv.key = 'tasks';

-- Older done subtasks had no completedAt; backfill once so the list can show a time.
UPDATE task_subtasks
SET completed_at = (SELECT COALESCE(t.completed_at, t.created_at) FROM tasks t WHERE t.id = task_subtasks.task_id)
WHERE done = 1 AND completed_at IS NULL;
