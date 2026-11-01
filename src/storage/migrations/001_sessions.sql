-- Session index baseline (spec 12.1): one row per session, plus where incremental parsing stopped.
-- Plain CREATE statements on purpose: a migration that meets existing objects must fail loudly.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  cwd TEXT,
  title TEXT,
  org_id TEXT,
  owner TEXT,
  parent TEXT,
  calling_session_id TEXT,
  calling_tool_use_id TEXT,
  mission TEXT,
  tags TEXT NOT NULL DEFAULT '{}',
  has_user_visible_messages INTEGER,
  archived_at TEXT,
  first_event_at INTEGER,
  last_event_at INTEGER,
  messages_count INTEGER NOT NULL DEFAULT 0,
  host_id TEXT,
  worktree TEXT,
  artifacts TEXT,
  settings_write_seq INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  preview TEXT NOT NULL DEFAULT '',
  transcript_path TEXT NOT NULL
);

CREATE TABLE session_ingest (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  transcript_mtime_ms REAL NOT NULL,
  transcript_size INTEGER NOT NULL,
  transcript_offset INTEGER NOT NULL,
  transcript_skipped_lines INTEGER NOT NULL DEFAULT 0,
  transcript_messages_count INTEGER NOT NULL DEFAULT 0,
  settings_mtime_ms REAL NOT NULL DEFAULT -1,
  settings_size INTEGER NOT NULL DEFAULT -1,
  transcript_summary_fingerprint TEXT,
  schema_version INTEGER NOT NULL
);

CREATE INDEX sessions_parent ON sessions(parent);
CREATE INDEX sessions_calling_session_id ON sessions(calling_session_id);
CREATE INDEX sessions_mission ON sessions(mission);
CREATE INDEX sessions_subagent ON sessions(json_extract(tags, '$.subagent'));
CREATE INDEX sessions_recent ON sessions(org_id, owner, project_key, last_event_at);
