-- 004_quiz_archive.sql
-- v0.6.0 — safe quiz delete: archive flag.
--
-- A quiz that has been used in one or more quiz_sessions cannot be hard-deleted
-- (its questions/options are referenced by answers, round_results, etc., and we
-- want to preserve historical session data). Such a quiz is ARCHIVED instead:
-- it stays in the DB but is hidden from the Create Session dropdown.
--
-- A quiz with no session references can still be hard-deleted; ON DELETE CASCADE
-- on questions / answer_options / *_translations cleans up dependent rows.

ALTER TABLE quizzes
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index: the common query is "list non-archived quizzes".
CREATE INDEX IF NOT EXISTS idx_quizzes_active
  ON quizzes (created_at DESC)
  WHERE is_archived = FALSE;
