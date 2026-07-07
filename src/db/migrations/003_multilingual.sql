-- 003_multilingual.sql
-- v0.5.0 — multilingual quiz content.
--
-- Design: the questions and answer_options rows stay as language-neutral
-- STRUCTURE (order, points, correctness). All human-readable TEXT moves into
-- per-language translation tables. The same approach applies to quiz titles
-- and descriptions.
--
-- Supported languages for now: 'sk', 'en', 'de'. We don't hard-constrain the
-- column to those three (a CHECK would make adding a language a migration);
-- the application validates the set instead. The column is short though.
--
-- Backward compatibility: existing single-language text in
-- questions.prompt / answer_options.text / quizzes.title / quizzes.description
-- is backfilled into 'en' translation rows. The original columns are KEPT
-- (not dropped) so any not-yet-deployed code, and the fallback path in the
-- new services, keep working. New writes populate both the translation rows
-- and (for questions/options) leave the legacy column holding the English
-- text as a convenience fallback.


-- ============================================================================
-- Quiz translations (title + description per language)
-- ============================================================================

CREATE TABLE IF NOT EXISTS quiz_translations (
  id          SERIAL PRIMARY KEY,
  quiz_id     INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  lang        VARCHAR(5) NOT NULL,
  title       VARCHAR(255) NOT NULL,
  description TEXT,
  CONSTRAINT uq_quiz_translations UNIQUE (quiz_id, lang)
);

CREATE INDEX IF NOT EXISTS idx_quiz_translations_quiz ON quiz_translations(quiz_id);


-- ============================================================================
-- Question translations (prompt per language)
-- ============================================================================

CREATE TABLE IF NOT EXISTS question_translations (
  id          SERIAL PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  lang        VARCHAR(5) NOT NULL,
  prompt      TEXT NOT NULL,
  CONSTRAINT uq_question_translations UNIQUE (question_id, lang)
);

CREATE INDEX IF NOT EXISTS idx_question_translations_question ON question_translations(question_id);


-- ============================================================================
-- Answer option translations (text per language)
-- ============================================================================

CREATE TABLE IF NOT EXISTS answer_option_translations (
  id        SERIAL PRIMARY KEY,
  option_id INTEGER NOT NULL REFERENCES answer_options(id) ON DELETE CASCADE,
  lang      VARCHAR(5) NOT NULL,
  text      TEXT NOT NULL,
  CONSTRAINT uq_answer_option_translations UNIQUE (option_id, lang)
);

CREATE INDEX IF NOT EXISTS idx_answer_option_translations_option ON answer_option_translations(option_id);


-- ============================================================================
-- Backfill existing content into 'en'
-- ============================================================================

-- Quizzes → quiz_translations (en)
INSERT INTO quiz_translations (quiz_id, lang, title, description)
SELECT q.id, 'en', q.title, q.description
  FROM quizzes q
 WHERE NOT EXISTS (
   SELECT 1 FROM quiz_translations t WHERE t.quiz_id = q.id AND t.lang = 'en'
 );

-- Questions → question_translations (en)
INSERT INTO question_translations (question_id, lang, prompt)
SELECT q.id, 'en', q.prompt
  FROM questions q
 WHERE NOT EXISTS (
   SELECT 1 FROM question_translations t WHERE t.question_id = q.id AND t.lang = 'en'
 );

-- Answer options → answer_option_translations (en)
INSERT INTO answer_option_translations (option_id, lang, text)
SELECT o.id, 'en', o.text
  FROM answer_options o
 WHERE NOT EXISTS (
   SELECT 1 FROM answer_option_translations t WHERE t.option_id = o.id AND t.lang = 'en'
 );
