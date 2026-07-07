-- 010_audio_recordings.sql
-- Audioguides library: metadata for uploaded audio files. The binary NEVER
-- lives in Postgres — only this row of metadata. The actual file is stored on
-- disk under AUDIO_DIR (a durable/persistent volume in production), addressed
-- by `storage_key` (a generated, sanitized name — never the user's filename).
--
-- Purely additive; nothing else is touched. A later phase (B2) may add an
-- optional reference from an AUDIO question item to a recording here.

CREATE TABLE IF NOT EXISTS audio_recordings (
  id               SERIAL PRIMARY KEY,
  title            VARCHAR(255) NOT NULL,
  original_name    VARCHAR(255),
  storage_key      VARCHAR(255) NOT NULL,
  mime             VARCHAR(100) NOT NULL,
  byte_size        BIGINT NOT NULL DEFAULT 0,
  duration_seconds INTEGER,                  -- nullable: probing may fail
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_audio_storage_key UNIQUE (storage_key)
);

CREATE INDEX IF NOT EXISTS idx_audio_recordings_created ON audio_recordings (created_at DESC);
