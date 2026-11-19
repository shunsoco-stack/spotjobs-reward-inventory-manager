CREATE TABLE IF NOT EXISTS sync_entries (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK(length(CAST(value AS BLOB)) <= 1048576),
  revision TEXT,
  expires_at INTEGER NOT NULL CHECK(expires_at > 0)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sync_entries_expiry
  ON sync_entries(expires_at);
