'use strict';

// Supported quiz-content languages. Order matters: it's the fallback
// preference order when a requested language is missing for some content.
const SUPPORTED_LANGS = ['en', 'sk', 'de'];
const DEFAULT_LANG = 'en';

const SUPPORTED_SET = new Set(SUPPORTED_LANGS);

/** Normalize a requested lang to a supported one, defaulting to 'en'. */
function normalizeLang(input) {
  if (!input || typeof input !== 'string') return DEFAULT_LANG;
  const l = input.trim().toLowerCase().slice(0, 5);
  return SUPPORTED_SET.has(l) ? l : DEFAULT_LANG;
}

function isSupported(lang) {
  return typeof lang === 'string' && SUPPORTED_SET.has(lang.toLowerCase());
}

/**
 * Given a map of { lang: value } and a requested lang, return the best value:
 * the requested one if present, else the first available in fallback order,
 * else null.
 */
function pickTranslation(byLang, requestedLang) {
  const want = normalizeLang(requestedLang);
  if (byLang[want] != null) return byLang[want];
  for (const l of SUPPORTED_LANGS) {
    if (byLang[l] != null) return byLang[l];
  }
  // Any remaining (non-standard) language present
  const keys = Object.keys(byLang);
  return keys.length ? byLang[keys[0]] : null;
}

module.exports = {
  SUPPORTED_LANGS,
  DEFAULT_LANG,
  normalizeLang,
  isSupported,
  pickTranslation,
};
