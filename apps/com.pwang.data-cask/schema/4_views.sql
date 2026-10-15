CREATE TABLE views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  schema_id TEXT NOT NULL,
  columns TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
