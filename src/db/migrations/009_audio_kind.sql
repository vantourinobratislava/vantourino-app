-- 009_audio_kind.sql
-- AUDIO items: a third kind of quiz item alongside questions and contests.
--
-- An audio item reuses the questions row for order + multilingual title
-- (prompt) + description (explanation). It has no options, no correct answer,
-- and no scoring. It carries an audio reference, stored for now as a plain URL
-- (a later phase may add an optional FK to an audio library).
--
-- Purely additive and backward-compatible: the CHECK is widened to allow
-- 'audio' (existing 'question'/'contest' rows are unaffected), and audio_url is
-- a nullable column.

ALTER TABLE questions DROP CONSTRAINT IF EXISTS chk_questions_kind;
ALTER TABLE questions
  ADD CONSTRAINT chk_questions_kind CHECK (kind IN ('question', 'contest', 'audio'));

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS audio_url VARCHAR(2048);
