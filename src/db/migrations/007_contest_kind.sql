-- 007_contest_kind.sql
-- Contest items: a second kind of quiz item alongside normal questions.
--
-- A contest reuses the questions row (order, prompt, explanation, points) but
-- has no options, no correct answer, and no team submissions — the admin awards
-- points manually, with `points` repurposed as the MAX awardable.
--
-- Manual awards are stored as rows in `answers` with option_id NULL and
-- points_awarded = the score, so we make answers.option_id nullable. Existing
-- question answers always set option_id, so this is a safe widening.

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS kind VARCHAR(16) NOT NULL DEFAULT 'question';

ALTER TABLE questions DROP CONSTRAINT IF EXISTS chk_questions_kind;
ALTER TABLE questions
  ADD CONSTRAINT chk_questions_kind CHECK (kind IN ('question', 'contest'));

-- Allow contest "answer" rows (manual awards) to have no option.
ALTER TABLE answers ALTER COLUMN option_id DROP NOT NULL;
