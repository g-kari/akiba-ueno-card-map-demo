-- Feature columns and tables: existence proof (verified + evidence URL +
-- timestamp), and inflow measurement events (detail views and outbound
-- clicks to Google Maps place / directions links).
ALTER TABLE stores ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stores ADD COLUMN source_url TEXT;
ALTER TABLE stores ADD COLUMN verified_at TEXT;

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_store_id ON events (store_id);
