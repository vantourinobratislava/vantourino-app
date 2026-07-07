-- 012_audio_guide_id.sql
-- Phase B2.2: AUDIO question items can reference an audio guide from the
-- library (set up in migration 011). Optional: existing AUDIO items with only
-- a raw audio_url continue to work as before — the link is additive.
--
-- ON DELETE SET NULL is critical: if a referenced guide is deleted, the
-- question's link is nulled and the item falls back to its raw audio_url (or
-- shows a clear empty state). Quizzes never break unexpectedly.

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS audio_guide_id INTEGER
    REFERENCES audio_guides(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_questions_audio_guide ON questions (audio_guide_id);
