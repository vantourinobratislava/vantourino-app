-- 005_question_explanation.sql
-- v0.7.0 — per-question multilingual explanation / comment.
--
-- The explanation rides alongside the prompt in question_translations: it's
-- the same (question_id, lang) grain, so no new table or join is needed. It's
-- nullable — existing questions simply have no explanation until one is added.

ALTER TABLE question_translations
  ADD COLUMN IF NOT EXISTS explanation TEXT;
