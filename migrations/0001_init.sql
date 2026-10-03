-- MicroBin for Cloudflare Workers: initial schema.
-- Apply with: pnpm run db:migrate:local  |  pnpm run db:migrate:remote

CREATE TABLE pastas (
  id               TEXT    PRIMARY KEY,
  -- 'text' pastas hold text and/or files, 'url' pastas are short links.
  kind             TEXT    NOT NULL CHECK (kind IN ('text', 'url')),
  -- Plain text, or an "mbx1." envelope for private/secret pastas. D1 rows are limited to 2 MB.
  content          TEXT    NOT NULL DEFAULT '',
  syntax           TEXT    NOT NULL DEFAULT 'none',
  privacy          TEXT    NOT NULL CHECK (privacy IN ('public', 'unlisted', 'readonly', 'private', 'secret')),
  editable         INTEGER NOT NULL DEFAULT 0 CHECK (editable IN (0, 1)),
  -- Password handling (readonly / private / secret only). See src/shared/crypto.ts.
  kdf_salt         TEXT,
  kdf_iter         INTEGER,
  verifier         TEXT,
  -- Unix timestamps in seconds. expires_at NULL = never.
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER,
  last_read_at     INTEGER NOT NULL,
  read_count       INTEGER NOT NULL DEFAULT 0,
  burn_after_reads INTEGER NOT NULL DEFAULT 0,
  -- Content bytes + stored file bytes (used by the admin view).
  total_size       INTEGER NOT NULL DEFAULT 0,
  -- 'pending' while files are still being uploaded; invisible to everyone but the uploader.
  status           TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active'))
);

CREATE INDEX idx_pastas_listing   ON pastas (created_at DESC) WHERE privacy = 'public' AND status = 'active';
CREATE INDEX idx_pastas_expires   ON pastas (expires_at)      WHERE expires_at IS NOT NULL;
CREATE INDEX idx_pastas_last_read ON pastas (last_read_at);
CREATE INDEX idx_pastas_pending   ON pastas (created_at)      WHERE status = 'pending';

CREATE TABLE pasta_files (
  paste_id  TEXT    NOT NULL REFERENCES pastas (id) ON DELETE CASCADE,
  idx       INTEGER NOT NULL,
  -- Display name. Empty for secret pastas (the real names live inside the encrypted manifest).
  name      TEXT    NOT NULL,
  -- Declared size until the upload completes, then the size of the stored object.
  size      INTEGER NOT NULL,
  r2_key    TEXT    NOT NULL UNIQUE,
  -- R2 multipart upload id while an upload is in flight.
  upload_id TEXT,
  uploaded  INTEGER NOT NULL DEFAULT 0 CHECK (uploaded IN (0, 1)),
  PRIMARY KEY (paste_id, idx)
);

-- Transactional outbox: R2 objects that must be deleted. Rows are inserted in the same batch
-- that deletes the pasta, so a crash can never leak objects; cron + waitUntil drain it.
CREATE TABLE r2_gc (
  r2_key    TEXT    PRIMARY KEY,
  upload_id TEXT,
  queued_at INTEGER NOT NULL
);
