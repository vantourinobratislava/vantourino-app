-- 001_initial.sql
-- Initial schema for bratislavabike-quiz-app v0.2.0

-- Session store for connect-pg-simple
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    VARCHAR        NOT NULL COLLATE "default",
  "sess"   JSON           NOT NULL,
  "expire" TIMESTAMP(6)   NOT NULL
) WITH (OIDS=FALSE);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
  ) THEN
    ALTER TABLE "session"
      ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");


-- Admins
CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(64)  UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);


-- Quizzes (a quiz is the template; quiz_sessions are runs of it)
CREATE TABLE IF NOT EXISTS quizzes (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(255) NOT NULL,
  description TEXT,
  created_by  INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- Quiz sessions (a live run of a quiz, identified by session_code)
CREATE TABLE IF NOT EXISTS quiz_sessions (
  id           SERIAL PRIMARY KEY,
  session_code VARCHAR(12) UNIQUE NOT NULL,
  quiz_id      INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_by   INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at   TIMESTAMPTZ,
  ended_at     TIMESTAMPTZ,
  CONSTRAINT chk_quiz_sessions_status
    CHECK (status IN ('pending', 'active', 'completed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_quiz_sessions_status     ON quiz_sessions(status);
CREATE INDEX IF NOT EXISTS idx_quiz_sessions_quiz_id    ON quiz_sessions(quiz_id);
CREATE INDEX IF NOT EXISTS idx_quiz_sessions_created_by ON quiz_sessions(created_by);


-- Teams (one row per team joining a session)
CREATE TABLE IF NOT EXISTS teams (
  id         SERIAL PRIMARY KEY,
  session_id INTEGER     NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  name       VARCHAR(100) NOT NULL,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_teams_session_name UNIQUE (session_id, name)
);

CREATE INDEX IF NOT EXISTS idx_teams_session_id ON teams(session_id);
