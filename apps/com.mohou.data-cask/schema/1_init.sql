CREATE TABLE schemas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  fields TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE records (
  id TEXT PRIMARY KEY,
  schema_id TEXT NOT NULL,
  data TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  opened_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX records_schema ON records(schema_id);
CREATE INDEX records_opened ON records(opened_at);
