-- 刻度清单 table layout: tasks + tags / subtasks / image meta.
-- Image bytes stay in kv (img_<id>); only metadata lives here.

CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 3,
  starts TEXT,
  due TEXT,
  start_time TEXT,
  end_time TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  doing INTEGER NOT NULL DEFAULT 0,
  doing_at INTEGER
);

CREATE INDEX tasks_due ON tasks(due, sort_order);
CREATE INDEX tasks_done ON tasks(done, completed_at);
CREATE INDEX tasks_sort ON tasks(sort_order);

CREATE TABLE task_tags (
  task_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);

CREATE INDEX task_tags_tag ON task_tags(tag);

CREATE TABLE task_subtasks (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  pos INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER
);

CREATE INDEX task_subtasks_task ON task_subtasks(task_id, pos);

CREATE TABLE task_images (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  pos INTEGER NOT NULL DEFAULT 0,
  w INTEGER NOT NULL DEFAULT 0,
  h INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX task_images_task ON task_images(task_id, pos);
