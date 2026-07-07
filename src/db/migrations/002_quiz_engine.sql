-- 002_quiz_engine.sql
-- v0.3.0 — quiz engine: content model, runtime state, answers, results.
--
-- Status values:
--   Session:  pending | active | round_results | finished | closed
--             ('completed', 'cancelled' from v0.2.0 are preserved in the CHECK
--              constraint only for backward compatibility with old rows;
--              v3 code never writes them.)
--   Question: not_started | live | closed
--             (Tracked on quiz_sessions.current_question_status. NULL means
--              no question is current. Per-question state is intentionally
--              per-session — the same quiz can run in two sessions at once.)


-- ============================================================================
-- Questions (belong to a quiz template)
-- ============================================================================

CREATE TABLE IF NOT EXISTS questions (
  id          SERIAL PRIMARY KEY,
  quiz_id     INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL,
  prompt      TEXT    NOT NULL,
  points      INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_questions_points_positive CHECK (points > 0),
  CONSTRAINT uq_questions_quiz_order       UNIQUE (quiz_id, order_index)
);

CREATE INDEX IF NOT EXISTS idx_questions_quiz_id ON questions(quiz_id);


-- ============================================================================
-- Answer options
-- ============================================================================

CREATE TABLE IF NOT EXISTS answer_options (
  id          SERIAL PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL,
  text        TEXT    NOT NULL,
  is_correct  BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_answer_options_question_order UNIQUE (question_id, order_index)
);

CREATE INDEX IF NOT EXISTS idx_answer_options_question_id ON answer_options(question_id);


-- ============================================================================
-- Extend quiz_sessions: runtime pointer + timing
-- ============================================================================

-- Drop the v2 CHECK and replace with one that allows the new states.
-- Legacy values kept in the allowed set for backward compatibility only.
ALTER TABLE quiz_sessions DROP CONSTRAINT IF EXISTS chk_quiz_sessions_status;
ALTER TABLE quiz_sessions
  ADD CONSTRAINT chk_quiz_sessions_status
    CHECK (status IN (
      'pending', 'active', 'round_results', 'finished', 'closed',
      'completed', 'cancelled'  -- legacy v0.2.0 values; v3 never writes
    ));

ALTER TABLE quiz_sessions
  ADD COLUMN IF NOT EXISTS answer_time_seconds       INTEGER     NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS current_question_id       INTEGER     REFERENCES questions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS current_question_status   VARCHAR(20),
  ADD COLUMN IF NOT EXISTS current_question_deadline TIMESTAMPTZ;

-- Question state CHECK on the single source of truth for "current question state".
ALTER TABLE quiz_sessions DROP CONSTRAINT IF EXISTS chk_quiz_sessions_question_status;
ALTER TABLE quiz_sessions
  ADD CONSTRAINT chk_quiz_sessions_question_status
    CHECK (current_question_status IS NULL
           OR current_question_status IN ('not_started', 'live', 'closed'));


-- ============================================================================
-- Teams: add per-team auth token (192 bits, base64url, stored plaintext)
-- ============================================================================

ALTER TABLE teams ADD COLUMN IF NOT EXISTS token VARCHAR(64);

ALTER TABLE teams DROP CONSTRAINT IF EXISTS uq_teams_token;
ALTER TABLE teams ADD CONSTRAINT uq_teams_token UNIQUE (token);


-- ============================================================================
-- Answers: ONE answer per team per question per session (DB-enforced)
-- ============================================================================

CREATE TABLE IF NOT EXISTS answers (
  id             SERIAL PRIMARY KEY,
  session_id     INTEGER NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  question_id    INTEGER NOT NULL REFERENCES questions(id)     ON DELETE CASCADE,
  team_id        INTEGER NOT NULL REFERENCES teams(id)         ON DELETE CASCADE,
  option_id      INTEGER NOT NULL REFERENCES answer_options(id) ON DELETE CASCADE,
  is_correct     BOOLEAN,
  points_awarded INTEGER,
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at   TIMESTAMPTZ,
  CONSTRAINT uq_answers_team_question UNIQUE (session_id, question_id, team_id)
);

CREATE INDEX IF NOT EXISTS idx_answers_session_question ON answers(session_id, question_id);
CREATE INDEX IF NOT EXISTS idx_answers_team             ON answers(team_id);


-- ============================================================================
-- Round results: per-team result for one finished question, with cumulative
-- ============================================================================

CREATE TABLE IF NOT EXISTS round_results (
  id                SERIAL PRIMARY KEY,
  session_id        INTEGER NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  question_id       INTEGER NOT NULL REFERENCES questions(id)     ON DELETE CASCADE,
  team_id           INTEGER NOT NULL REFERENCES teams(id)         ON DELETE CASCADE,
  answered          BOOLEAN NOT NULL DEFAULT FALSE,
  is_correct        BOOLEAN NOT NULL DEFAULT FALSE,
  points_awarded    INTEGER NOT NULL DEFAULT 0,
  rank              INTEGER NOT NULL,
  cumulative_points INTEGER NOT NULL DEFAULT 0,
  finalized_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_round_results UNIQUE (session_id, question_id, team_id)
);

CREATE INDEX IF NOT EXISTS idx_round_results_session_question ON round_results(session_id, question_id);
CREATE INDEX IF NOT EXISTS idx_round_results_session          ON round_results(session_id);


-- ============================================================================
-- Final results: frozen standings, written at last finishQuestion or at close
-- ============================================================================

CREATE TABLE IF NOT EXISTS final_results (
  id           SERIAL PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  team_id      INTEGER NOT NULL REFERENCES teams(id)         ON DELETE CASCADE,
  total_points INTEGER NOT NULL DEFAULT 0,
  rank         INTEGER NOT NULL,
  finalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_final_results UNIQUE (session_id, team_id)
);

CREATE INDEX IF NOT EXISTS idx_final_results_session ON final_results(session_id);
