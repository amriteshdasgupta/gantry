-- A removed workspace keeps its tickets and history until it is added again.
ALTER TABLE projects ADD COLUMN removed_at TEXT;
