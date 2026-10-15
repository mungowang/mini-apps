-- Manual order for tables and rows (no separate order table).
ALTER TABLE schemas ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE records ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

UPDATE schemas SET sort_order = created_at WHERE sort_order = 0;
UPDATE records SET sort_order = created_at WHERE sort_order = 0;
