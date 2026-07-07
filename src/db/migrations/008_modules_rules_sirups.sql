-- 008_modules_rules_sirups.sql
-- Persistence for the Rules and Sirups modules. Purely additive — no existing
-- table is touched. Multilingual via per-language rows (same pattern as the
-- quiz translation tables).

-- Keyed multilingual content blocks (Rules now; reusable later). One row per
-- (content_key, lang).
CREATE TABLE IF NOT EXISTS app_content (
  id           SERIAL PRIMARY KEY,
  content_key  VARCHAR(64) NOT NULL,
  lang         VARCHAR(5)  NOT NULL,
  title        VARCHAR(255),
  body         TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_app_content UNIQUE (content_key, lang)
);

-- Ordered sirups list + per-language title/description.
CREATE TABLE IF NOT EXISTS sirups (
  id          SERIAL PRIMARY KEY,
  order_index INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_sirups_order UNIQUE (order_index)
);

CREATE TABLE IF NOT EXISTS sirup_translations (
  id          SERIAL PRIMARY KEY,
  sirup_id    INTEGER NOT NULL REFERENCES sirups(id) ON DELETE CASCADE,
  lang        VARCHAR(5) NOT NULL,
  title       VARCHAR(255) NOT NULL,
  description TEXT,
  CONSTRAINT uq_sirup_tr UNIQUE (sirup_id, lang)
);

CREATE INDEX IF NOT EXISTS idx_sirup_tr_sirup ON sirup_translations (sirup_id);
