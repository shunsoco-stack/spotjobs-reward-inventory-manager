export const GET_SQL = `SELECT value FROM sync_entries WHERE key = ?1 AND expires_at > ?2`;

export const SET_SQL = `
INSERT INTO sync_entries (key, value, revision, expires_at)
VALUES (?1, ?2, NULL, ?3)
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value, revision = NULL, expires_at = excluded.expires_at
`;

// Both the existence/revision test and mutation happen in one SQLite statement.
// A null expected revision only creates an absent or expired key. A non-null
// revision can update an unexpired matching row, but can never create a row.
export const CAS_SQL = `
INSERT INTO sync_entries (key, value, revision, expires_at)
SELECT ?1, ?2, ?3, ?4
WHERE ?5 IS NULL OR EXISTS (
  SELECT 1 FROM sync_entries
  WHERE key = ?1 AND revision = ?5 AND expires_at > ?6
)
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  revision = excluded.revision,
  expires_at = excluded.expires_at
WHERE (?5 IS NULL AND sync_entries.expires_at <= ?6)
  OR (?5 IS NOT NULL AND sync_entries.expires_at > ?6 AND sync_entries.revision = ?5)
`;

export const DELETE_SQL = `DELETE FROM sync_entries WHERE key = ?1`;
export const PING_SQL = `SELECT key FROM sync_entries LIMIT 0`;
export const CLEANUP_BATCH_SIZE = 1000;

// Indexed and bounded: cron never scans or deletes the entire table.
export const CLEANUP_SQL = `
DELETE FROM sync_entries
WHERE key IN (
  SELECT key FROM sync_entries INDEXED BY idx_sync_entries_expiry
  WHERE expires_at <= ?1 ORDER BY expires_at LIMIT ?2
)
`;
