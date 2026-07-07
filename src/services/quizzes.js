'use strict';

const pool = require('../db/pool');
const HttpError = require('../utils/httpError');
const { SUPPORTED_LANGS, DEFAULT_LANG, normalizeLang, isSupported } = require('../utils/languages');

function cleanTitle(title) {
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    throw new HttpError(400, 'title is required');
  }
  return title.trim().slice(0, 255);
}
function cleanDescription(description) {
  if (description === undefined || description === null || description === '') return null;
  return String(description).slice(0, 5000);
}

/**
 * Normalize the create payload into a per-language map of { title, description }.
 *
 * Accepts either:
 *   - legacy: { title, description }  → treated as English
 *   - multilingual: { translations: { en: {title, description}, sk: {...} } }
 *
 * At least one translation (with a title) is required. English is recommended
 * but not mandated; whatever languages are provided are stored.
 */
function normalizeTranslations({ title, description, translations }) {
  const out = {};

  if (translations && typeof translations === 'object') {
    for (const [rawLang, val] of Object.entries(translations)) {
      if (!isSupported(rawLang)) continue; // ignore unknown languages
      if (!val || typeof val !== 'object') continue;
      if (val.title == null || String(val.title).trim().length === 0) continue;
      out[rawLang.toLowerCase()] = {
        title: cleanTitle(val.title),
        description: cleanDescription(val.description),
      };
    }
  }

  // Legacy single-language fields → English (only if not already provided).
  if (title != null && out[DEFAULT_LANG] == null) {
    out[DEFAULT_LANG] = { title: cleanTitle(title), description: cleanDescription(description) };
  }

  if (Object.keys(out).length === 0) {
    throw new HttpError(400, 'At least one language with a title is required');
  }
  return out;
}

async function create({ title, description, translations, adminId }) {
  const langMap = normalizeTranslations({ title, description, translations });

  // Pick a representative title/description for the legacy columns: prefer
  // English, else the first provided. Keeps quizzes.title populated so old
  // reads and the fallback path still work.
  const repLang = langMap[DEFAULT_LANG] ? DEFAULT_LANG : Object.keys(langMap)[0];
  const rep = langMap[repLang];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO quizzes (title, description, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, title, description, created_at`,
      [rep.title, rep.description, adminId]
    );
    const quiz = rows[0];

    for (const [lang, val] of Object.entries(langMap)) {
      await client.query(
        `INSERT INTO quiz_translations (quiz_id, lang, title, description)
         VALUES ($1, $2, $3, $4)`,
        [quiz.id, lang, val.title, val.description]
      );
    }

    await client.query('COMMIT');
    return { ...quiz, translations: langMap, languages: Object.keys(langMap) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getById(quizId) {
  const { rows } = await pool.query(
    `SELECT id, title, description, created_at FROM quizzes WHERE id = $1 LIMIT 1`,
    [quizId]
  );
  return rows[0] || null;
}

/** Per-quiz translations as { lang: { title, description } }. */
async function getTranslations(quizId) {
  const { rows } = await pool.query(
    `SELECT lang, title, description FROM quiz_translations WHERE quiz_id = $1`,
    [quizId]
  );
  const byLang = {};
  for (const r of rows) byLang[r.lang] = { title: r.title, description: r.description };
  return byLang;
}

/**
 * List quizzes with question counts and available languages, plus the
 * title/description resolved for the requested language (fallback applied).
 * Powers the admin "create session" dropdown. Archived quizzes are excluded
 * unless includeArchived is true.
 */
async function listAll({ lang, includeArchived = false } = {}) {
  const want = normalizeLang(lang);

  const { rows } = await pool.query(
    `SELECT
       q.id,
       q.created_at,
       q.is_archived,
       q.title       AS legacy_title,
       q.description AS legacy_description,
       COALESCE(qc.cnt, 0)::int AS question_count
     FROM quizzes q
     LEFT JOIN (
       SELECT quiz_id, COUNT(*) AS cnt FROM questions GROUP BY quiz_id
     ) qc ON qc.quiz_id = q.id
     WHERE ($1::boolean = TRUE OR q.is_archived = FALSE)
     ORDER BY q.created_at DESC, q.id DESC`,
    [includeArchived]
  );
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const { rows: trs } = await pool.query(
    `SELECT quiz_id, lang, title, description FROM quiz_translations
      WHERE quiz_id = ANY($1::int[])`,
    [ids]
  );
  const byQuiz = new Map();
  for (const t of trs) {
    if (!byQuiz.has(t.quiz_id)) byQuiz.set(t.quiz_id, {});
    byQuiz.get(t.quiz_id)[t.lang] = { title: t.title, description: t.description };
  }

  return rows.map((r) => {
    const tr = byQuiz.get(r.id) || {};
    const languages = Object.keys(tr);
    // Resolve display title/description for the requested language.
    let chosen = tr[want];
    if (!chosen) {
      for (const l of SUPPORTED_LANGS) { if (tr[l]) { chosen = tr[l]; break; } }
    }
    if (!chosen) chosen = { title: r.legacy_title, description: r.legacy_description };

    return {
      id: r.id,
      title: chosen.title,
      description: chosen.description,
      questionCount: r.question_count,
      languages: languages.length ? languages : [DEFAULT_LANG],
      isArchived: r.is_archived,
      createdAt: r.created_at,
    };
  });
}

/**
 * List questions for a quiz, resolved to one language. Used by the session
 * detail view. includeCorrect controls whether is_correct is exposed.
 */
async function listQuestions(quizId, { includeCorrect = false, lang } = {}) {
  const want = normalizeLang(lang);

  const { rows: questions } = await pool.query(
    `SELECT q.id, q.quiz_id, q.order_index, q.points, q.kind, q.audio_url, q.audio_guide_id, q.created_at,
            q.prompt AS legacy_prompt
       FROM questions q
      WHERE q.quiz_id = $1
      ORDER BY q.order_index ASC`,
    [quizId]
  );
  if (questions.length === 0) return [];
  const qIds = questions.map((q) => q.id);

  // Question prompts in all languages → resolve per question.
  const { rows: qTr } = await pool.query(
    `SELECT question_id, lang, prompt FROM question_translations
      WHERE question_id = ANY($1::int[])`,
    [qIds]
  );
  const promptByQ = new Map();
  for (const t of qTr) {
    if (!promptByQ.has(t.question_id)) promptByQ.set(t.question_id, {});
    promptByQ.get(t.question_id)[t.lang] = t.prompt;
  }

  // Options (structure) + their translations.
  const optCols = includeCorrect
    ? 'id, question_id, order_index, is_correct'
    : 'id, question_id, order_index';
  const { rows: options } = await pool.query(
    `SELECT ${optCols}, text AS legacy_text FROM answer_options
      WHERE question_id = ANY($1::int[])
      ORDER BY question_id ASC, order_index ASC`,
    [qIds]
  );
  const optIds = options.map((o) => o.id);
  let textByOpt = new Map();
  if (optIds.length) {
    const { rows: oTr } = await pool.query(
      `SELECT option_id, lang, text FROM answer_option_translations
        WHERE option_id = ANY($1::int[])`,
      [optIds]
    );
    for (const t of oTr) {
      if (!textByOpt.has(t.option_id)) textByOpt.set(t.option_id, {});
      textByOpt.get(t.option_id)[t.lang] = t.text;
    }
  }

  const resolve = (byLang, legacy) => {
    if (byLang) {
      if (byLang[want] != null) return byLang[want];
      for (const l of SUPPORTED_LANGS) if (byLang[l] != null) return byLang[l];
      const ks = Object.keys(byLang);
      if (ks.length) return byLang[ks[0]];
    }
    return legacy;
  };

  const optByQ = new Map();
  for (const o of options) {
    if (!optByQ.has(o.question_id)) optByQ.set(o.question_id, []);
    const base = {
      id: o.id,
      question_id: o.question_id,
      order_index: o.order_index,
      text: resolve(textByOpt.get(o.id), o.legacy_text),
    };
    if (includeCorrect) base.is_correct = o.is_correct;
    optByQ.get(o.question_id).push(base);
  }

  return questions.map((q) => ({
    id: q.id,
    quiz_id: q.quiz_id,
    order_index: q.order_index,
    points: q.points,
    kind: q.kind || 'question',
    audioUrl: q.audio_url || null,
    audioGuideId: q.audio_guide_id == null ? null : Number(q.audio_guide_id),
    created_at: q.created_at,
    prompt: resolve(promptByQ.get(q.id), q.legacy_prompt),
    options: optByQ.get(q.id) || [],
  }));
}

/**
 * Full quiz for the admin editor: all quiz translations + all questions with
 * every language's prompt and option texts, plus structural data (points,
 * order, which option is correct). This is admin-only (exposes correctness).
 */
async function getFull(quizId) {
  const { rows: qRows } = await pool.query(
    `SELECT id, title, description, is_archived, created_at FROM quizzes WHERE id = $1 LIMIT 1`,
    [quizId]
  );
  if (!qRows[0]) return null;
  const quiz = qRows[0];

  const translations = await getTranslations(quizId);

  const { rows: questions } = await pool.query(
    `SELECT id, order_index, points, kind, audio_url, audio_guide_id, prompt AS legacy_prompt
       FROM questions WHERE quiz_id = $1 ORDER BY order_index ASC`,
    [quizId]
  );
  const qIds = questions.map((q) => q.id);

  let promptByQ = new Map();
  let explByQ = new Map();
  let optByQ = new Map();
  let textByOpt = new Map();

  if (qIds.length) {
    const { rows: qTr } = await pool.query(
      `SELECT question_id, lang, prompt, explanation FROM question_translations WHERE question_id = ANY($1::int[])`,
      [qIds]
    );
    for (const t of qTr) {
      if (!promptByQ.has(t.question_id)) promptByQ.set(t.question_id, {});
      promptByQ.get(t.question_id)[t.lang] = t.prompt;
      if (t.explanation != null) {
        if (!explByQ.has(t.question_id)) explByQ.set(t.question_id, {});
        explByQ.get(t.question_id)[t.lang] = t.explanation;
      }
    }

    const { rows: opts } = await pool.query(
      `SELECT id, question_id, order_index, is_correct, text AS legacy_text
         FROM answer_options WHERE question_id = ANY($1::int[])
        ORDER BY question_id ASC, order_index ASC`,
      [qIds]
    );
    const optIds = opts.map((o) => o.id);
    for (const o of opts) {
      if (!optByQ.has(o.question_id)) optByQ.set(o.question_id, []);
      optByQ.get(o.question_id).push(o);
    }
    if (optIds.length) {
      const { rows: oTr } = await pool.query(
        `SELECT option_id, lang, text FROM answer_option_translations WHERE option_id = ANY($1::int[])`,
        [optIds]
      );
      for (const t of oTr) {
        if (!textByOpt.has(t.option_id)) textByOpt.set(t.option_id, {});
        textByOpt.get(t.option_id)[t.lang] = t.text;
      }
    }
  }

  const questionsOut = questions.map((q) => {
    const prompts = promptByQ.get(q.id) || {};
    if (Object.keys(prompts).length === 0 && q.legacy_prompt) prompts.en = q.legacy_prompt;
    const opts = (optByQ.get(q.id) || []).map((o) => {
      const texts = textByOpt.get(o.id) || {};
      if (Object.keys(texts).length === 0 && o.legacy_text) texts.en = o.legacy_text;
      return {
        id: o.id,
        orderIndex: o.order_index,
        isCorrect: o.is_correct,
        texts, // { en, sk, de }
      };
    });
    return {
      id: q.id,
      orderIndex: q.order_index,
      points: q.points,
      kind: q.kind || 'question',
      audioUrl: q.audio_url || null,
      audioGuideId: q.audio_guide_id == null ? null : Number(q.audio_guide_id),
      prompts, // { en, sk, de }
      explanations: explByQ.get(q.id) || {}, // { en?, sk?, de? }
      options: opts,
    };
  });

  return {
    id: quiz.id,
    isArchived: quiz.is_archived,
    createdAt: quiz.created_at,
    translations, // { en: {title, description}, ... }
    languages: Object.keys(translations),
    questions: questionsOut,
  };
}

/**
 * Update quiz title/description translations. Body: { translations: { en: {title, description?}, ... } }.
 * Upserts each provided language; languages not provided are left untouched.
 * Updates the legacy quizzes.title/description to the representative language.
 */
async function updateMetadata(quizId, { translations }) {
  if (!translations || typeof translations !== 'object' || Object.keys(translations).length === 0) {
    throw new HttpError(400, 'translations are required');
  }

  const clean = {};
  for (const [rawLang, val] of Object.entries(translations)) {
    if (!isSupported(rawLang)) continue;
    if (!val || typeof val !== 'object') continue;
    if (val.title == null || String(val.title).trim().length === 0) {
      throw new HttpError(400, `title is required for language "${rawLang}"`);
    }
    clean[rawLang.toLowerCase()] = {
      title: cleanTitle(val.title),
      description: cleanDescription(val.description),
    };
  }
  if (Object.keys(clean).length === 0) {
    throw new HttpError(400, 'no supported-language translations provided');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: exists } = await client.query(`SELECT id FROM quizzes WHERE id = $1 FOR UPDATE`, [quizId]);
    if (!exists[0]) throw new HttpError(404, 'Quiz not found');

    for (const [lang, val] of Object.entries(clean)) {
      await client.query(
        `INSERT INTO quiz_translations (quiz_id, lang, title, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (quiz_id, lang)
         DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description`,
        [quizId, lang, val.title, val.description]
      );
    }

    // Keep legacy columns in sync with the representative language.
    const { rows: allTr } = await client.query(
      `SELECT lang, title, description FROM quiz_translations WHERE quiz_id = $1`,
      [quizId]
    );
    const byLang = {};
    for (const r of allTr) byLang[r.lang] = { title: r.title, description: r.description };
    const repLang = byLang[DEFAULT_LANG] ? DEFAULT_LANG : Object.keys(byLang)[0];
    if (repLang) {
      await client.query(
        `UPDATE quizzes SET title = $2, description = $3 WHERE id = $1`,
        [quizId, byLang[repLang].title, byLang[repLang].description]
      );
    }

    await client.query('COMMIT');
    return getFull(quizId);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Count quiz_sessions that reference this quiz. */
async function countSessionRefs(quizId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM quiz_sessions WHERE quiz_id = $1`,
    [quizId]
  );
  return rows[0].c;
}

/**
 * Safe delete:
 *   - no session references  → hard delete (CASCADE removes questions, options,
 *     and all *_translations).
 *   - has session references → archive (is_archived = TRUE), preserving history.
 *
 * Returns { action: 'deleted' | 'archived' }.
 */
async function remove(quizId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, is_archived FROM quizzes WHERE id = $1 FOR UPDATE`,
      [quizId]
    );
    if (!rows[0]) throw new HttpError(404, 'Quiz not found');

    const { rows: refRows } = await client.query(
      `SELECT COUNT(*)::int AS c FROM quiz_sessions WHERE quiz_id = $1`,
      [quizId]
    );
    const refs = refRows[0].c;

    let action;
    if (refs === 0) {
      // Hard delete. answer_option_translations / question_translations /
      // quiz_translations / answer_options / questions all cascade from quizzes
      // via ON DELETE CASCADE chains.
      await client.query(`DELETE FROM quizzes WHERE id = $1`, [quizId]);
      action = 'deleted';
    } else {
      await client.query(`UPDATE quizzes SET is_archived = TRUE WHERE id = $1`, [quizId]);
      action = 'archived';
    }

    await client.query('COMMIT');
    return { action, sessionRefs: refs };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Deep-copy a quiz into a brand-new, independent quiz.
 *
 * Clones, with fresh IDs, in one transaction:
 *   - quizzes row (title suffixed " (copy)"; not archived)
 *   - quiz_translations (all languages; title suffixed per language)
 *   - questions (same order_index)
 *   - question_translations (prompt + explanation, all languages)
 *   - answer_options (text, is_correct, order_index)
 *   - answer_option_translations (text, all languages)
 *
 * The copy has no sessions and is fully editable on its own.
 */
async function duplicate(quizId, { adminId } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: srcRows } = await client.query(
      `SELECT id, title, description FROM quizzes WHERE id = $1`,
      [quizId]
    );
    if (!srcRows[0]) throw new HttpError(404, 'Quiz not found');
    const src = srcRows[0];

    // New quiz row.
    const { rows: newQ } = await client.query(
      `INSERT INTO quizzes (title, description, created_by, is_archived)
       VALUES ($1, $2, $3, FALSE)
       RETURNING id, title, description, created_at`,
      [`${src.title} (copy)`, src.description, adminId || null]
    );
    const newQuizId = newQ[0].id;

    // Quiz translations.
    await client.query(
      `INSERT INTO quiz_translations (quiz_id, lang, title, description)
       SELECT $1::int, lang, title || ' (copy)', description
         FROM quiz_translations WHERE quiz_id = $2::int`,
      [newQuizId, quizId]
    );

    // Questions → map old id → new id.
    const { rows: srcQuestions } = await client.query(
      `SELECT id, order_index, prompt, points FROM questions WHERE quiz_id = $1 ORDER BY order_index ASC`,
      [quizId]
    );
    for (const q of srcQuestions) {
      const { rows: nq } = await client.query(
        `INSERT INTO questions (quiz_id, order_index, prompt, points)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [newQuizId, q.order_index, q.prompt, q.points]
      );
      const newQid = nq[0].id;

      await client.query(
        `INSERT INTO question_translations (question_id, lang, prompt, explanation)
         SELECT $1::int, lang, prompt, explanation FROM question_translations WHERE question_id = $2::int`,
        [newQid, q.id]
      );

      // Options → map old option id → new option id.
      const { rows: srcOpts } = await client.query(
        `SELECT id, order_index, text, is_correct FROM answer_options WHERE question_id = $1 ORDER BY order_index ASC`,
        [q.id]
      );
      for (const o of srcOpts) {
        const { rows: no } = await client.query(
          `INSERT INTO answer_options (question_id, order_index, text, is_correct)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [newQid, o.order_index, o.text, o.is_correct]
        );
        const newOid = no[0].id;
        await client.query(
          `INSERT INTO answer_option_translations (option_id, lang, text)
           SELECT $1::int, lang, text FROM answer_option_translations WHERE option_id = $2::int`,
          [newOid, o.id]
        );
      }
    }

    await client.query('COMMIT');
    return { id: newQuizId, title: newQ[0].title, createdAt: newQ[0].created_at };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  create,
  getById,
  getFull,
  getTranslations,
  listAll,
  listQuestions,
  updateMetadata,
  countSessionRefs,
  remove,
  duplicate,
};
