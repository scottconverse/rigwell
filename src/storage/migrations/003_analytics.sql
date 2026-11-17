-- Rebuildable accounting cache, using the transcript ingest's complete-line boundary.
CREATE TABLE session_analytics (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  inherited_lines INTEGER NOT NULL DEFAULT 0,
  legacy_fork INTEGER NOT NULL DEFAULT 0,
  inherited_usage TEXT NOT NULL DEFAULT '{}',
  settings_usage TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE analytics_events (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  timestamp INTEGER,
  data TEXT NOT NULL,
  PRIMARY KEY (session_id, line_number, slot)
);
CREATE INDEX analytics_events_date ON analytics_events(timestamp);
