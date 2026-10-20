CREATE TABLE saved_queries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  q TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE query_history (
  id TEXT PRIMARY KEY,
  q TEXT NOT NULL,
  used_at INTEGER NOT NULL
);

CREATE INDEX query_history_used ON query_history(used_at);
