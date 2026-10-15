CREATE TABLE text_parsers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  preprocess_source TEXT NOT NULL DEFAULT '',
  parse_line_source TEXT NOT NULL,
  sample_raw TEXT NOT NULL DEFAULT '',
  built_in INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
