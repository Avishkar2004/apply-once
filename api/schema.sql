-- AutoFill sync service — D1 schema (WEB.md §8).
--
-- The server stores opaque bytes. There is no column here it can interpret:
-- `ciphertext` is AES-GCM sealed with a key derived on the client, and the
-- event's kind, company, status and text are all inside it.
--
-- Run with:  npm run db:local   (or db:remote)

-- ── Accounts ────────────────────────────────────────────────────────────────
-- §3.1: the server holds the per-account salt, a hash of the auth key, and the
-- two wrapped copies of the DEK. It can decrypt none of them.
CREATE TABLE IF NOT EXISTS accounts (
  user_id               TEXT PRIMARY KEY,
  email                 TEXT NOT NULL UNIQUE,
  -- PBKDF2 salt the CLIENT uses to derive MUK + auth key. Public by design.
  salt                  BLOB NOT NULL,
  -- Server-side hash of the auth key, with its own salt. Never the key itself.
  auth_hash             BLOB NOT NULL,
  auth_salt             BLOB NOT NULL,
  auth_iterations       INTEGER NOT NULL,
  -- AES-KW(MUK, DEK) and AES-KW(recovery KEK, DEK). Opaque to the server.
  wrapped_dek           BLOB NOT NULL,
  wrapped_dek_recovery  BLOB NOT NULL,
  -- Running totals so the §8 quota is a read, not a COUNT(*) scan.
  event_count           INTEGER NOT NULL DEFAULT 0,
  byte_count            INTEGER NOT NULL DEFAULT 0,
  -- §10: "a 'web access off' account switch that makes the server reject all
  -- /sync reads for that account".
  web_access            INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- ── Event log ───────────────────────────────────────────────────────────────
-- Verbatim from WEB.md §8, plus the account foreign key.
CREATE TABLE IF NOT EXISTS events (
  user_id     TEXT NOT NULL,
  id          TEXT NOT NULL,               -- UUIDv7, client-generated
  seq         INTEGER NOT NULL,            -- server-assigned, monotonic per user
  device_id   TEXT NOT NULL,
  iv          BLOB NOT NULL,
  ciphertext  BLOB NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

-- UNIQUE, not just an index. `seq` is the pull cursor: two rows sharing one seq
-- make `WHERE seq > ?` skip whichever the page boundary did not reach, losing an
-- event with no error anywhere. The range is reserved atomically in
-- routes/sync.ts, and this is the backstop that turns any future regression into
-- a loud constraint violation instead of silent data loss.
CREATE UNIQUE INDEX IF NOT EXISTS events_cursor ON events (user_id, seq);

-- ── Per-user sequence counter ───────────────────────────────────────────────
-- §8: "`seq` comes from a per-user counter updated in the same transaction as
-- the insert. D1 serializes writes per database, so this is safe without
-- additional locking."
CREATE TABLE IF NOT EXISTS sequences (
  user_id   TEXT PRIMARY KEY,
  high_water INTEGER NOT NULL DEFAULT 0
);

-- ── Blob index ──────────────────────────────────────────────────────────────
-- Bytes live in R2; this is what makes account deletion a single transaction
-- (§4.5) instead of an R2 prefix walk.
CREATE TABLE IF NOT EXISTS blobs (
  user_id     TEXT NOT NULL,
  hash        TEXT NOT NULL,               -- SHA-256 of the PLAINTEXT (§2)
  byte_count  INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, hash)
);
