-- 006_question_pause.sql
-- Phase 3 — pause/resume a live question.
--
-- Adds two nullable columns to track a paused timer, and extends the question
-- status CHECK to allow 'paused'. When paused: current_question_status =
-- 'paused', current_question_deadline = NULL, paused_at = NOW(), remaining_ms =
-- whatever time was left. Resume recomputes the deadline from remaining_ms and
-- flips back to 'live'. Existing rows are unaffected (both columns nullable).

ALTER TABLE quiz_sessions
  ADD COLUMN IF NOT EXISTS paused_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS remaining_ms INTEGER;

-- Allow the new 'paused' question status alongside the existing values.
ALTER TABLE quiz_sessions DROP CONSTRAINT IF EXISTS chk_quiz_sessions_question_status;
ALTER TABLE quiz_sessions
  ADD CONSTRAINT chk_quiz_sessions_question_status
    CHECK (current_question_status IS NULL
           OR current_question_status IN ('not_started', 'live', 'paused', 'closed'));
