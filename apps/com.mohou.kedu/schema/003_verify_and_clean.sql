-- Verify the kv -> table migration, then drop the old kv row.
-- Any mismatch violates the CHECK constraint: the whole file rolls back,
-- the 'tasks' kv row stays, and the file re-runs after the problem is fixed.
-- Fresh installs: no 'tasks' kv row, every check is 0 = 0, nothing is deleted.

CREATE TABLE _kv_tasks_check (
  label TEXT PRIMARY KEY,
  expected INTEGER NOT NULL,
  actual INTEGER NOT NULL,
  ok INTEGER NOT NULL CHECK (ok = 1)
);

INSERT INTO _kv_tasks_check (label, expected, actual, ok)
SELECT 'tasks',
  COALESCE((SELECT json_array_length(kv.value) FROM kv WHERE kv.key = 'tasks'), 0),
  (SELECT COUNT(*) FROM tasks),
  CASE WHEN COALESCE((SELECT json_array_length(kv.value) FROM kv WHERE kv.key = 'tasks'), 0)
    = (SELECT COUNT(*) FROM tasks) THEN 1 ELSE 0 END;

INSERT INTO _kv_tasks_check (label, expected, actual, ok)
SELECT 'task_tags',
  COALESCE((SELECT SUM(json_array_length(e.value, '$.tags'))
    FROM kv, json_each(kv.value) AS e WHERE kv.key = 'tasks'), 0),
  (SELECT COUNT(*) FROM task_tags),
  CASE WHEN COALESCE((SELECT SUM(json_array_length(e.value, '$.tags'))
    FROM kv, json_each(kv.value) AS e WHERE kv.key = 'tasks'), 0)
    = (SELECT COUNT(*) FROM task_tags) THEN 1 ELSE 0 END;

INSERT INTO _kv_tasks_check (label, expected, actual, ok)
SELECT 'task_subtasks',
  COALESCE((SELECT SUM(json_array_length(e.value, '$.subtasks'))
    FROM kv, json_each(kv.value) AS e WHERE kv.key = 'tasks'), 0),
  (SELECT COUNT(*) FROM task_subtasks),
  CASE WHEN COALESCE((SELECT SUM(json_array_length(e.value, '$.subtasks'))
    FROM kv, json_each(kv.value) AS e WHERE kv.key = 'tasks'), 0)
    = (SELECT COUNT(*) FROM task_subtasks) THEN 1 ELSE 0 END;

INSERT INTO _kv_tasks_check (label, expected, actual, ok)
SELECT 'task_images',
  COALESCE((SELECT SUM(json_array_length(e.value, '$.images'))
    FROM kv, json_each(kv.value) AS e WHERE kv.key = 'tasks'), 0),
  (SELECT COUNT(*) FROM task_images),
  CASE WHEN COALESCE((SELECT SUM(json_array_length(e.value, '$.images'))
    FROM kv, json_each(kv.value) AS e WHERE kv.key = 'tasks'), 0)
    = (SELECT COUNT(*) FROM task_images) THEN 1 ELSE 0 END;

-- No child row may point at a task that does not exist.
INSERT INTO _kv_tasks_check (label, expected, actual, ok)
SELECT 'no_dangling_children', 0,
  (SELECT COUNT(*) FROM task_tags g LEFT JOIN tasks t ON t.id = g.task_id WHERE t.id IS NULL)
  + (SELECT COUNT(*) FROM task_subtasks s LEFT JOIN tasks t ON t.id = s.task_id WHERE t.id IS NULL)
  + (SELECT COUNT(*) FROM task_images i LEFT JOIN tasks t ON t.id = i.task_id WHERE t.id IS NULL),
  CASE WHEN
    (SELECT COUNT(*) FROM task_tags g LEFT JOIN tasks t ON t.id = g.task_id WHERE t.id IS NULL)
    + (SELECT COUNT(*) FROM task_subtasks s LEFT JOIN tasks t ON t.id = s.task_id WHERE t.id IS NULL)
    + (SELECT COUNT(*) FROM task_images i LEFT JOIN tasks t ON t.id = i.task_id WHERE t.id IS NULL)
    = 0 THEN 1 ELSE 0 END;

-- All checks passed: the tables hold everything the kv row held. Drop the old row.
DELETE FROM kv WHERE key = 'tasks';

DROP TABLE _kv_tasks_check;
