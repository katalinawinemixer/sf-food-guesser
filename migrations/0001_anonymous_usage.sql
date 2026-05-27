CREATE TABLE IF NOT EXISTS anonymous_usage (
  usage_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS anonymous_usage_expires_at_idx
  ON anonymous_usage (expires_at);
