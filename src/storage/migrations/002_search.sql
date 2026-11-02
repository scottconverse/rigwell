-- Local search (spec 12.1): searchable spans, per-session bloom filters, ingest tail bookkeeping, stale-settings and vector_epoch triggers.
-- Plain CREATE statements on purpose, like the baseline.
ALTER TABLE session_ingest ADD COLUMN span_tail_offset INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_ingest ADD COLUMN span_tail_line INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_ingest ADD COLUMN span_tail_index INTEGER NOT NULL DEFAULT 0;

CREATE TABLE session_spans (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  span_index INTEGER NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  text TEXT NOT NULL,
  first_event_id TEXT,
  last_event_id TEXT,
  scale REAL,
  vector BLOB,
  text_sha256 TEXT,
  embedding_space TEXT,
  synced_at INTEGER,
  PRIMARY KEY (session_id, span_index)
);
CREATE INDEX session_spans_space ON session_spans(embedding_space);

CREATE TABLE session_term_filters (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  filter BLOB NOT NULL
);

INSERT INTO meta (key, value) VALUES ('vector_epoch', '0');

-- Three triggers bump vector_epoch whenever the set or text of spans changes (embedding writes do not).
CREATE TRIGGER session_spans_epoch_insert AFTER INSERT ON session_spans
BEGIN UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'vector_epoch'; END;
CREATE TRIGGER session_spans_epoch_update AFTER UPDATE OF text, line_start, line_end, session_id, span_index ON session_spans
BEGIN UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'vector_epoch'; END;
CREATE TRIGGER session_spans_epoch_delete AFTER DELETE ON session_spans
BEGIN UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'vector_epoch'; END;

-- A row whose settings were rewritten, or whose daemon-owned fields changed, has its settings re-read on the next ingest.
CREATE TRIGGER sessions_settings_rewritten AFTER UPDATE OF settings_write_seq ON sessions
WHEN OLD.settings_write_seq IS NOT NEW.settings_write_seq
BEGIN UPDATE session_ingest SET settings_mtime_ms = -1, settings_size = -1 WHERE session_id = NEW.session_id; END;
CREATE TRIGGER sessions_daemon_fields_stale AFTER UPDATE OF org_id, artifacts ON sessions
WHEN OLD.org_id IS NOT NEW.org_id OR OLD.artifacts IS NOT NEW.artifacts
BEGIN UPDATE session_ingest SET settings_mtime_ms = -1, settings_size = -1 WHERE session_id = NEW.session_id; END;
