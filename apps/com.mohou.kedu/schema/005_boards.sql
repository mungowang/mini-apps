-- Boards: top-level partitions of the task list.
-- tasks.board_id NULL = 默认 board, a built-in pseudo-board that cannot be
-- renamed or deleted. Existing rows keep NULL, so no backfill is needed.

CREATE TABLE boards (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX boards_sort ON boards(sort_order);

ALTER TABLE tasks ADD COLUMN board_id TEXT;

CREATE INDEX tasks_board ON tasks(board_id);
