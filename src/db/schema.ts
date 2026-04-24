export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  branch TEXT,
  intent TEXT,
  pid INTEGER,
  hostname TEXT,
  started_at INTEGER NOT NULL,
  last_heartbeat INTEGER NOT NULL,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_heartbeat ON sessions(last_heartbeat);

CREATE TABLE IF NOT EXISTS resource_locks (
  resource TEXT NOT NULL,
  project TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch TEXT,
  reason TEXT,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (project, resource),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_locks_expires ON resource_locks(expires_at);
CREATE INDEX IF NOT EXISTS idx_locks_session ON resource_locks(session_id);

CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  from_session TEXT NOT NULL,
  from_branch TEXT,
  message TEXT NOT NULL,
  tags TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_project ON inbox(project, created_at DESC);

CREATE TABLE IF NOT EXISTS inbox_reads (
  session_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, message_id)
);
`;

export const SESSION_TTL_MS = 10 * 60 * 1000;
export const LOCK_DEFAULT_TTL_MS = 10 * 60 * 1000;
export const INBOX_RETENTION_MS = 24 * 60 * 60 * 1000;
