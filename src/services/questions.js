'use strict';

const pool = require('../db/pool');
const HttpError = require('../utils/httpError');
const quizzes = require('./quizzes');
const { DEFAULT_LANG, isSupported } = require('../utils/languages');

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const MAX_PROMPT_LEN = 2000;
const MAX_OPTION_LEN = 500;
const MAX_POINTS = 1000;

/**
 * Normalize an addQuestion payload into:
 *   {
 *     points,
 *     optionCount,
 *     correctIndex,                       // 0-based, language-neutral
 *     byLang: { en: { prompt, options:[text,...] }, sk: {...}, ... }
 *   }
 *
 * Accepts two shapes:
 *
 *  (A) Multilingual:
 *      {
 *        points,
 *        correctIndex,                    // 0-based
 *        translations: {
 *          en: { prompt, options: ["A","B","C"] },
 *          sk: { prompt, options: ["...","...","..."] }
 *        }
 *      }
 *
 *  (B) Legacy single-language (treated as English):
 *      {
 *        prompt, points,
 *        options: [{ text, isCorrect }, ...]
 *      }
 *
 * Validation: every provided language must have the SAME number of options as
 * the structure, in the same order. Exactly one correct option overall.
 */
function normalize(payload) {
  const points = normalizePoints(payload.points);

  // ---- Legacy shape ----
  if (Array.isArray(payload.options) && payload.options.length && payload.options[0] && 'text' in payload.options[0]) {
    const opts = payload.options;
    if (opts.length < MIN_OPTIONS || opts.length > MAX_OPTIONS) {
      throw new HttpError(400, `options must be ${MIN_OPTIONS}–${MAX_OPTIONS} items`);
    }
    const prompt = cleanPrompt(payload.prompt);
    let correctIndex = -1;
    const texts = [];
    opts.forEach((o, i) => {
      if (!o || typeof o.text !== 'string' || o.text.trim().length === 0) {
        throw new HttpError(400, 'each option must have non-empty text');
      }
      texts.push(o.text.trim().slice(0, MAX_OPTION_LEN));
      if (o.isCorrect === true) {
        if (correctIndex !== -1) throw new HttpError(400, 'only one option may be correct');
        correctIndex = i;
      }
    });
    if (correctIndex === -1) throw new HttpError(400, 'exactly one option must be marked correct');
    return {
      points,
      optionCount: texts.length,
      correctIndex,
      byLang: { [DEFAULT_LANG]: { prompt, options: texts } },
    };
  }

  // ---- Multilingual shape ----
  const translations = payload.translations;
  if (!translations || typeof translations !== 'object' || Object.keys(translations).length === 0) {
    throw new HttpError(400, 'translations (or legacy prompt+options) are required');
  }

  const byLang = {};
  let optionCount = null;
  for (const [rawLang, val] of Object.entries(translations)) {
    if (!isSupported(rawLang)) continue;
    if (!val || typeof val !== 'object') continue;
    const prompt = cleanPrompt(val.prompt);
    if (!Array.isArray(val.options)) {
      throw new HttpError(400, `options for "${rawLang}" must be an array`);
    }
    const texts = val.options.map((t) => {
      if (typeof t !== 'string' || t.trim().length === 0) {
        throw new HttpError(400, `every option for "${rawLang}" must be non-empty text`);
      }
      return t.trim().slice(0, MAX_OPTION_LEN);
    });
    if (texts.length < MIN_OPTIONS || texts.length > MAX_OPTIONS) {
      throw new HttpError(400, `"${rawLang}" must have ${MIN_OPTIONS}–${MAX_OPTIONS} options`);
    }
    if (optionCount === null) optionCount = texts.length;
    else if (texts.length !== optionCount) {
      throw new HttpError(400, 'every language must have the same number of options, in the same order');
    }
    const entry = { prompt, options: texts };
    // Optional explanation/comment for this language.
    if (val.explanation != null && String(val.explanation).trim().length > 0) {
      entry.explanation = String(val.explanation).trim().slice(0, MAX_PROMPT_LEN);
    }
    byLang[rawLang.toLowerCase()] = entry;
  }

  if (Object.keys(byLang).length === 0) {
    throw new HttpError(400, 'at least one supported-language translation is required');
  }

  const correctIndex = Number(payload.correctIndex);
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= optionCount) {
    throw new HttpError(400, `correctIndex must be an integer between 0 and ${optionCount - 1}`);
  }

  return { points, optionCount, correctIndex, byLang };
}

/**
 * Normalize a CONTEST item: multilingual title (prompt) + optional description
 * (explanation) + max points. No options, no correct answer. Mirrors the
 * multilingual prompt/explanation handling of normalize() but skips options.
 */
function normalizeContest(payload) {
  const points = normalizePoints(payload.points); // repurposed as MAX awardable
  const translations = payload.translations;
  if (!translations || typeof translations !== 'object' || Object.keys(translations).length === 0) {
    throw new HttpError(400, 'translations are required for a contest');
  }
  const byLang = {};
  for (const [rawLang, val] of Object.entries(translations)) {
    if (!isSupported(rawLang)) continue;
    if (!val || typeof val !== 'object') continue;
    const prompt = cleanPrompt(val.prompt);
    const entry = { prompt, options: [] };
    if (val.explanation != null && String(val.explanation).trim().length > 0) {
      entry.explanation = String(val.explanation).trim().slice(0, MAX_PROMPT_LEN);
    }
    byLang[rawLang.toLowerCase()] = entry;
  }
  if (Object.keys(byLang).length === 0) {
    throw new HttpError(400, 'at least one supported-language title is required for a contest');
  }
  return { points, optionCount: 0, correctIndex: -1, byLang, kind: 'contest' };
}

/**
 * Normalize an AUDIO item: multilingual title (prompt) + optional description
 * (explanation) + an audio URL. No options, no correct answer, no scoring
 * (points forced to 0). Mirrors the contest shape but adds audioUrl.
 */
function normalizeAudio(payload) {
  const translations = payload.translations;
  if (!translations || typeof translations !== 'object' || Object.keys(translations).length === 0) {
    throw new HttpError(400, 'translations are required for an audio item');
  }
  const byLang = {};
  for (const [rawLang, val] of Object.entries(translations)) {
    if (!isSupported(rawLang)) continue;
    if (!val || typeof val !== 'object') continue;
    const prompt = cleanPrompt(val.prompt);
    const entry = { prompt, options: [] };
    if (val.explanation != null && String(val.explanation).trim().length > 0) {
      entry.explanation = String(val.explanation).trim().slice(0, MAX_PROMPT_LEN);
    }
    byLang[rawLang.toLowerCase()] = entry;
  }
  if (Object.keys(byLang).length === 0) {
    throw new HttpError(400, 'at least one supported-language title is required for an audio item');
  }
  let audioUrl = null;
  if (payload.audioUrl != null && String(payload.audioUrl).trim().length > 0) {
    audioUrl = String(payload.audioUrl).trim().slice(0, 2048);
  }
  // Optional link to an Audioguides library guide (B2.2). When set, the live
  // read prefers it over audioUrl; audioUrl is kept as a fallback.
  let audioGuideId = null;
  if (payload.audioGuideId != null && payload.audioGuideId !== '') {
    const g = Number(payload.audioGuideId);
    if (!Number.isInteger(g) || g < 1) throw new HttpError(400, 'invalid audioGuideId');
    audioGuideId = g;
  }
  // points are irrelevant for audio (no scoring); store 1 to satisfy the
  // questions.points > 0 CHECK. The session flow never reads it for audio.
  return { points: 1, optionCount: 0, correctIndex: -1, byLang, kind: 'audio', audioUrl, audioGuideId };
}

function cleanPrompt(prompt) {
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new HttpError(400, 'prompt is required for each language');
  }
  const t = prompt.trim();
  if (t.length > MAX_PROMPT_LEN) throw new HttpError(400, `prompt must be at most ${MAX_PROMPT_LEN} characters`);
  return t;
}
function normalizePoints(points) {
  if (points === undefined || points === null) return 1;
  const n = Number(points);
  if (!Number.isInteger(n) || n < 1 || n > MAX_POINTS) {
    throw new HttpError(400, `points must be an integer between 1 and ${MAX_POINTS}`);
  }
  return n;
}

async function addQuestion(quizId, payload) {
  const kind = payload.kind === 'contest' ? 'contest' : (payload.kind === 'audio' ? 'audio' : 'question');
  const norm = kind === 'contest' ? normalizeContest(payload)
    : kind === 'audio' ? normalizeAudio(payload)
    : normalize(payload);

  const quiz = await quizzes.getById(quizId);
  if (!quiz) throw new HttpError(404, 'Quiz not found');

  let orderIndex;
  if (payload.orderIndex !== undefined && payload.orderIndex !== null) {
    orderIndex = Number(payload.orderIndex);
    if (!Number.isInteger(orderIndex) || orderIndex < 1) {
      throw new HttpError(400, 'orderIndex must be a positive integer');
    }
  }

  // Representative (legacy column) text: English if present, else first lang.
  const repLang = norm.byLang[DEFAULT_LANG] ? DEFAULT_LANG : Object.keys(norm.byLang)[0];
  const rep = norm.byLang[repLang];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (orderIndex === undefined) {
      const { rows } = await client.query(
        `SELECT COALESCE(MAX(order_index), 0) + 1 AS next FROM questions WHERE quiz_id = $1`,
        [quizId]
      );
      orderIndex = rows[0].next;
    }

    let questionRow;
    try {
      const { rows } = await client.query(
        `INSERT INTO questions (quiz_id, order_index, prompt, points, kind, audio_url, audio_guide_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, quiz_id, order_index, prompt, points, kind, audio_url, audio_guide_id, created_at`,
        [quizId, orderIndex, rep.prompt, norm.points, kind, norm.audioUrl ?? null, norm.audioGuideId ?? null]
      );
      questionRow = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        throw new HttpError(409, `A question with orderIndex ${orderIndex} already exists in this quiz`);
      }
      throw err;
    }

    // Question prompt translations
    for (const [lang, val] of Object.entries(norm.byLang)) {
      await client.query(
        `INSERT INTO question_translations (question_id, lang, prompt, explanation) VALUES ($1, $2, $3, $4)`,
        [questionRow.id, lang, val.prompt, val.explanation ?? null]
      );
    }

    // Options: questions only. Contests have none.
    const optionRows = [];
    if (kind === 'question') {
      for (let i = 0; i < norm.optionCount; i++) {
        const isCorrect = i === norm.correctIndex;
        const repText = rep.options[i];
        const { rows } = await client.query(
          `INSERT INTO answer_options (question_id, order_index, text, is_correct)
           VALUES ($1, $2, $3, $4)
           RETURNING id, question_id, order_index, text, is_correct`,
          [questionRow.id, i + 1, repText, isCorrect]
        );
        const optRow = rows[0];

        for (const [lang, val] of Object.entries(norm.byLang)) {
          await client.query(
            `INSERT INTO answer_option_translations (option_id, lang, text) VALUES ($1, $2, $3)`,
            [optRow.id, lang, val.options[i]]
          );
        }
        optionRows.push(optRow);
      }
    }

    await client.query('COMMIT');
    return {
      question: questionRow,
      options: optionRows,
      languages: Object.keys(norm.byLang),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getById(questionId) {
  const { rows } = await pool.query(
    `SELECT id, quiz_id, order_index, prompt, points, created_at
       FROM questions WHERE id = $1 LIMIT 1`,
    [questionId]
  );
  return rows[0] || null;
}

/**
 * Update an existing question's editable content WITHOUT changing its option
 * structure (count or identity). This keeps referential integrity bulletproof
 * even after the quiz has been used in sessions (answers / round_results point
 * at option ids).
 *
 * Editable:
 *   - points
 *   - prompt translations (per language; upserted)
 *   - option text translations (per language, per existing option; upserted)
 *   - which option is correct (correctOptionId — must be one of this
 *     question's existing options)
 *
 * NOT editable here (deferred): adding/removing options or reordering. To
 * change the option set, delete the quiz (if unused) and recreate, or add a
 * brand-new question.
 *
 * payload shape:
 *   {
 *     points?,                       // optional
 *     correctOptionId?,              // optional; existing option id
 *     prompts?: { en, sk, de },      // optional; any subset of supported langs
 *     options?: [                    // optional; entries reference existing ids
 *       { id, texts: { en, sk, de } }
 *     ]
 *   }
 *
 * Note: changing the correct option does NOT retroactively rescore rounds that
 * already finished; it only affects questions started after the change.
 */
async function updateQuestion(quizId, questionId, payload) {
  const qid = Number(questionId);
  if (!Number.isInteger(qid) || qid < 1) throw new HttpError(400, 'invalid questionId');

  const body = payload || {};
  let points;
  if (body.points !== undefined && body.points !== null) {
    points = normalizePoints(body.points);
  }

  const prompts = {};
  if (body.prompts && typeof body.prompts === 'object') {
    for (const [rawLang, val] of Object.entries(body.prompts)) {
      if (!isSupported(rawLang)) continue;
      prompts[rawLang.toLowerCase()] = cleanPrompt(val);
    }
  }

  // Optional explanation edits per language. An empty string clears it (NULL).
  const explanations = {};
  if (body.explanations && typeof body.explanations === 'object') {
    for (const [rawLang, val] of Object.entries(body.explanations)) {
      if (!isSupported(rawLang)) continue;
      if (val == null) continue;
      const t = String(val).trim();
      explanations[rawLang.toLowerCase()] = t.length ? t.slice(0, MAX_PROMPT_LEN) : null;
    }
  }

  // Optional audio URL edit (audio items). Empty string clears it (NULL).
  let audioUrl; // undefined = not provided
  if (body.audioUrl !== undefined) {
    const a = body.audioUrl == null ? '' : String(body.audioUrl).trim();
    audioUrl = a.length ? a.slice(0, 2048) : null;
  }

  // Optional audio guide link (B2.2). undefined = leave; null/'' = clear;
  // positive int = set.
  let audioGuideId; // undefined sentinel
  if (body.audioGuideId !== undefined) {
    if (body.audioGuideId === null || body.audioGuideId === '') {
      audioGuideId = null;
    } else {
      const g = Number(body.audioGuideId);
      if (!Number.isInteger(g) || g < 1) throw new HttpError(400, 'invalid audioGuideId');
      audioGuideId = g;
    }
  }

  // Option text edits, keyed by existing option id.
  const optionEdits = [];
  if (Array.isArray(body.options)) {
    for (const o of body.options) {
      if (!o || typeof o !== 'object') continue;
      const oid = Number(o.id);
      if (!Number.isInteger(oid) || oid < 1) throw new HttpError(400, 'each option edit needs a valid id');
      const texts = {};
      if (o.texts && typeof o.texts === 'object') {
        for (const [rawLang, val] of Object.entries(o.texts)) {
          if (!isSupported(rawLang)) continue;
          if (typeof val !== 'string' || val.trim().length === 0) {
            throw new HttpError(400, `option ${oid}: text for "${rawLang}" must be non-empty`);
          }
          texts[rawLang.toLowerCase()] = val.trim().slice(0, MAX_OPTION_LEN);
        }
      }
      if (Object.keys(texts).length) optionEdits.push({ id: oid, texts });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the question; confirm it belongs to this quiz.
    const { rows: qRows } = await client.query(
      `SELECT id, quiz_id, prompt FROM questions WHERE id = $1 FOR UPDATE`,
      [qid]
    );
    if (!qRows[0]) throw new HttpError(404, 'Question not found');
    if (qRows[0].quiz_id !== Number(quizId)) {
      throw new HttpError(400, 'Question does not belong to this quiz');
    }

    // Existing options for this question (id set + validity checks).
    const { rows: existingOpts } = await client.query(
      `SELECT id FROM answer_options WHERE question_id = $1 ORDER BY order_index ASC`,
      [qid]
    );
    const validOptIds = new Set(existingOpts.map((o) => o.id));

    // Validate correctOptionId (if provided) belongs to this question.
    let correctOptionId;
    if (body.correctOptionId !== undefined && body.correctOptionId !== null) {
      correctOptionId = Number(body.correctOptionId);
      if (!validOptIds.has(correctOptionId)) {
        throw new HttpError(400, 'correctOptionId must be one of this question\'s options');
      }
    }

    // Validate option edits reference this question's options.
    for (const edit of optionEdits) {
      if (!validOptIds.has(edit.id)) {
        throw new HttpError(400, `option ${edit.id} does not belong to this question`);
      }
    }

    // ---- Apply ----

    if (points !== undefined) {
      await client.query(`UPDATE questions SET points = $2 WHERE id = $1`, [qid, points]);
    }

    if (audioUrl !== undefined) {
      await client.query(`UPDATE questions SET audio_url = $2 WHERE id = $1`, [qid, audioUrl]);
    }

    if (audioGuideId !== undefined) {
      await client.query(`UPDATE questions SET audio_guide_id = $2 WHERE id = $1`, [qid, audioGuideId]);
    }

    // Prompt translations (upsert). Keep legacy prompt column synced to the
    // representative language.
    for (const [lang, prompt] of Object.entries(prompts)) {
      await client.query(
        `INSERT INTO question_translations (question_id, lang, prompt)
         VALUES ($1, $2, $3)
         ON CONFLICT (question_id, lang) DO UPDATE SET prompt = EXCLUDED.prompt`,
        [qid, lang, prompt]
      );
    }
    if (Object.keys(prompts).length) {
      const { rows: allPr } = await client.query(
        `SELECT lang, prompt FROM question_translations WHERE question_id = $1`,
        [qid]
      );
      const byLang = {};
      for (const r of allPr) byLang[r.lang] = r.prompt;
      const repLang = byLang[DEFAULT_LANG] ? DEFAULT_LANG : Object.keys(byLang)[0];
      if (repLang) {
        await client.query(`UPDATE questions SET prompt = $2 WHERE id = $1`, [qid, byLang[repLang]]);
      }
    }

    // Explanation translations. For a language that already has a prompt row
    // (or just got one above), set/clear its explanation. For a language with
    // no prompt row yet, we can only attach an explanation if a prompt for that
    // language was provided in this same request.
    for (const [lang, explanation] of Object.entries(explanations)) {
      const { rowCount } = await client.query(
        `UPDATE question_translations SET explanation = $3
          WHERE question_id = $1 AND lang = $2`,
        [qid, lang, explanation]
      );
      if (rowCount === 0) {
        // No row for this lang. Only create one if we have a prompt for it.
        if (prompts[lang] != null) {
          await client.query(
            `INSERT INTO question_translations (question_id, lang, prompt, explanation)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (question_id, lang)
             DO UPDATE SET explanation = EXCLUDED.explanation`,
            [qid, lang, prompts[lang], explanation]
          );
        } else {
          throw new HttpError(400, `cannot set explanation for "${lang}" without a prompt in that language`);
        }
      }
    }

    // Option text translations (upsert), and sync legacy text column.
    for (const edit of optionEdits) {
      for (const [lang, text] of Object.entries(edit.texts)) {
        await client.query(
          `INSERT INTO answer_option_translations (option_id, lang, text)
           VALUES ($1, $2, $3)
           ON CONFLICT (option_id, lang) DO UPDATE SET text = EXCLUDED.text`,
          [edit.id, lang, text]
        );
      }
      const { rows: allOt } = await client.query(
        `SELECT lang, text FROM answer_option_translations WHERE option_id = $1`,
        [edit.id]
      );
      const byLang = {};
      for (const r of allOt) byLang[r.lang] = r.text;
      const repLang = byLang[DEFAULT_LANG] ? DEFAULT_LANG : Object.keys(byLang)[0];
      if (repLang) {
        await client.query(`UPDATE answer_options SET text = $2 WHERE id = $1`, [edit.id, byLang[repLang]]);
      }
    }

    // Correct option change (flip is_correct).
    if (correctOptionId !== undefined) {
      await client.query(
        `UPDATE answer_options SET is_correct = (id = $2) WHERE question_id = $1`,
        [qid, correctOptionId]
      );
    }

    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reorder a quiz's questions. `orderedIds` must be exactly the quiz's current
 * question IDs (a permutation — no missing, extra, or duplicate IDs).
 *
 * Two-pass to respect UNIQUE(quiz_id, order_index): first bump every row to a
 * high offset (current + 100000) so no target value collides, then assign the
 * final 1..N. All in one transaction. Reordering only changes order_index;
 * answers/round_results reference question_id, so session history is unaffected.
 */
async function reorder(quizId, orderedIds) {
  const qid = Number(quizId);
  if (!Number.isInteger(qid) || qid < 1) throw new HttpError(400, 'invalid quizId');
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw new HttpError(400, 'orderedIds must be a non-empty array');
  }
  const ids = orderedIds.map((x) => Number(x));
  if (ids.some((x) => !Number.isInteger(x) || x < 1)) {
    throw new HttpError(400, 'orderedIds must be positive integers');
  }
  if (new Set(ids).size !== ids.length) {
    throw new HttpError(400, 'orderedIds contains duplicates');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the quiz's questions and confirm the set matches exactly.
    const { rows: existing } = await client.query(
      `SELECT id FROM questions WHERE quiz_id = $1 FOR UPDATE`,
      [qid]
    );
    const existingSet = new Set(existing.map((r) => r.id));
    if (existingSet.size !== ids.length || !ids.every((id) => existingSet.has(id))) {
      throw new HttpError(400, 'orderedIds must be exactly this quiz\'s question IDs');
    }

    const OFFSET = 100000;
    // Pass 1: move everything out of the way to avoid unique collisions.
    await client.query(
      `UPDATE questions SET order_index = order_index + $2 WHERE quiz_id = $1`,
      [qid, OFFSET]
    );
    // Pass 2: assign final positions 1..N in the requested order.
    for (let i = 0; i < ids.length; i++) {
      await client.query(
        `UPDATE questions SET order_index = $3 WHERE quiz_id = $1 AND id = $2`,
        [qid, ids[i], i + 1]
      );
    }

    await client.query('COMMIT');
    return { ok: true, count: ids.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Delete a single quiz item (question OR contest). Removes the question row —
 * which cascades its translations, options, and any answers/round_results that
 * reference it via ON DELETE CASCADE — then renumbers the remaining items so
 * order_index stays a contiguous 1..N with no gaps.
 *
 * The renumber uses the same two-pass offset trick as reorder() to respect
 * UNIQUE(quiz_id, order_index): bump survivors out of the way (+100000), then
 * assign 1..N by current order. All in one transaction with FOR UPDATE, so a
 * concurrent edit can't corrupt the ordering.
 */
async function deleteQuestion(quizId, questionId) {
  const qzId = Number(quizId);
  const qId = Number(questionId);
  if (!Number.isInteger(qzId) || qzId < 1) throw new HttpError(400, 'invalid quizId');
  if (!Number.isInteger(qId) || qId < 1) throw new HttpError(400, 'invalid questionId');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the quiz's items; confirm the target belongs to this quiz.
    const { rows: existing } = await client.query(
      `SELECT id FROM questions WHERE quiz_id = $1 ORDER BY order_index ASC FOR UPDATE`,
      [qzId]
    );
    if (!existing.some((r) => r.id === qId)) {
      throw new HttpError(404, 'Item not found in this quiz');
    }

    // Delete the item (cascades translations/options/answers/round_results).
    await client.query(`DELETE FROM questions WHERE id = $1 AND quiz_id = $2`, [qId, qzId]);

    // Renumber survivors to a contiguous 1..N, preserving their relative order.
    const survivors = existing.filter((r) => r.id !== qId).map((r) => r.id);
    const OFFSET = 100000;
    await client.query(
      `UPDATE questions SET order_index = order_index + $2 WHERE quiz_id = $1`,
      [qzId, OFFSET]
    );
    for (let i = 0; i < survivors.length; i++) {
      await client.query(
        `UPDATE questions SET order_index = $3 WHERE quiz_id = $1 AND id = $2`,
        [qzId, survivors[i], i + 1]
      );
    }

    await client.query('COMMIT');
    return { ok: true, deletedId: qId, remaining: survivors.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { addQuestion, getById, updateQuestion, reorder, deleteQuestion };
