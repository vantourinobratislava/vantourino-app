-- 011_audio_guides.sql
-- Audioguides B2.1: introduce guides + per-language variants.
--
-- One "guide" is one conceptual audio item (e.g. "Welcome to Bratislava") that
-- can have up to one audio file per supported language. The audio files are
-- still rows in `audio_recordings` (B1) — we just add a guide_id + lang to
-- group them. A recording can also exist standalone (guide_id NULL) just like
-- in B1; existing rows are unaffected by this migration.
--
-- Supported languages: en, de, sk, it, es, fr.
--
-- Purely additive and idempotent. A later phase (B2.2) will add an optional
-- FK from AUDIO question items to a guide here, with ON DELETE SET NULL so
-- deleting a guide never breaks an existing quiz.

CREATE TABLE IF NOT EXISTS audio_guides (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(255) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audio_guides_created ON audio_guides (created_at DESC);

-- Grouping columns on recordings. Both nullable: a standalone recording has
-- neither; an attached variant has both.
ALTER TABLE audio_recordings
  ADD COLUMN IF NOT EXISTS guide_id INTEGER REFERENCES audio_guides(id) ON DELETE SET NULL;

ALTER TABLE audio_recordings
  ADD COLUMN IF NOT EXISTS lang VARCHAR(5);

-- Allowed language codes for variants. NULL is allowed (standalone recording).
ALTER TABLE audio_recordings DROP CONSTRAINT IF EXISTS chk_audio_recordings_lang;
ALTER TABLE audio_recordings
  ADD CONSTRAINT chk_audio_recordings_lang
  CHECK (lang IS NULL OR lang IN ('en','de','sk','it','es','fr'));

-- At most one variant per (guide_id, lang) when both are set.
CREATE UNIQUE INDEX IF NOT EXISTS uq_audio_recordings_guide_lang
  ON audio_recordings (guide_id, lang)
  WHERE guide_id IS NOT NULL AND lang IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audio_recordings_guide ON audio_recordings (guide_id);
