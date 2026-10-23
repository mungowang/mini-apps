-- Connectors: generic external task sources (Jira via MCP, any REST list).
-- kind: "mcp" | "http". source/params/mapping/options are JSON — no code changes per source.

CREATE TABLE connectors (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '{}',
  params TEXT NOT NULL DEFAULT '{}',
  root_path TEXT NOT NULL DEFAULT '',
  mapping TEXT NOT NULL DEFAULT '{}',
  options TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_run_result TEXT
);

-- Task <-> external record: dedupe key, change detection, delete tombstones.
-- deleted_at set when the local task was removed by the user; re-sync never resurrects it.
CREATE TABLE task_links (
  connector_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  raw_hash TEXT NOT NULL DEFAULT '',
  deleted_at INTEGER,
  PRIMARY KEY (connector_id, external_id)
);

CREATE INDEX task_links_task ON task_links(task_id);
