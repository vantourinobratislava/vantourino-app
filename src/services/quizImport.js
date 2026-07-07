'use strict';

const XLSX = require('xlsx');
const pool = require('../db/pool');
const HttpError = require('../utils/httpError');
const { SUPPORTED_LANGS, DEFAULT_LANG, isSupported } = require('../utils/languages');

/*
 * Bulk quiz import from a single .xlsx workbook. One file = one quiz.
 *
 * ── Sheet "Meta" ──────────────────────────────────────────────────────────
 *   Columns (header row): lang | title | description
 *   One row per language (en/sk/de). At least one row required; a title is
 *   required per row, description optional.
 *
 * ── Sheet "Questions" ─────────────────────────────────────────────────────
 *   Header row, one data row per question. Columns:
 *     order            (optional int; defaults to row order)
 *     points           (int 1..1000)
 *     correct          (int 1..N — which option is correct, 1-based)
 *     prompt_en, opt1_en, opt2_en, opt3_en, opt4_en, explanation_en
 *     prompt_sk, opt1_sk, ...                          explanation_sk
 *     prompt_de, opt1_de, ...                          explanation_de
 *   A language is "present" for a question if its prompt_<lang> is non-empty.
 *   For each present language, prompt + all option cells (opt1..optN) must be
 *   filled and the option COUNT must match across present languages.
 *   `explanation_<lang>` is optional.
 *
 * Validation produces per-row errors; nothing is written during preview.
 * Commit re-validates the normalized payload and writes everything in one
 * transaction (all-or-nothing).
 */

const MAX_QUESTIONS = 200;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const MAX_POINTS = 1000;

function cellStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

/** Parse a workbook buffer into our normalized payload + validation errors. */
function parseWorkbook(buffer) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    throw new HttpError(400, 'Could not read the file as a spreadsheet (.xlsx).');
  }

  const errors = [];
  const findSheet = (name) => {
    const key = wb.SheetNames.find((n) => n.trim().toLowerCase() === name);
    return key ? wb.Sheets[key] : null;
  };

  const metaSheet = findSheet('meta');
  const qSheet = findSheet('questions');
  if (!metaSheet) errors.push({ scope: 'file', message: 'Missing required sheet "Meta".' });
  if (!qSheet) errors.push({ scope: 'file', message: 'Missing required sheet "Questions".' });
  if (!metaSheet || !qSheet) {
    return { ok: false, errors, quiz: null };
  }

  // ---- Meta ----
  const metaRows = XLSX.utils.sheet_to_json(metaSheet, { defval: '' });
  const translations = {};
  metaRows.forEach((row, i) => {
    const lang = cellStr(row.lang || row.Lang || row.LANG).toLowerCase();
    if (!lang) return;
    if (!isSupported(lang)) {
      errors.push({ scope: 'meta', row: i + 2, message: `Unsupported language "${lang}" (use en/sk/de).` });
      return;
    }
    const title = cellStr(row.title || row.Title);
    if (!title) {
      errors.push({ scope: 'meta', row: i + 2, message: `Missing title for "${lang}".` });
      return;
    }
    translations[lang] = { title, description: cellStr(row.description || row.Description) || undefined };
  });
  if (Object.keys(translations).length === 0) {
    errors.push({ scope: 'meta', message: 'No valid language rows with a title in "Meta".' });
  }

  // ---- Questions ----
  const qRows = XLSX.utils.sheet_to_json(qSheet, { defval: '' });
  if (qRows.length === 0) errors.push({ scope: 'questions', message: 'No question rows found.' });
  if (qRows.length > MAX_QUESTIONS) {
    errors.push({ scope: 'questions', message: `Too many questions (${qRows.length}); max ${MAX_QUESTIONS}.` });
  }

  const questions = [];
  qRows.slice(0, MAX_QUESTIONS).forEach((row, idx) => {
    const rowNo = idx + 2; // header is row 1
    const points = Number(cellStr(row.points || row.Points));
    const correct = Number(cellStr(row.correct || row.Correct));
    const orderRaw = cellStr(row.order || row.Order);
    const order = orderRaw ? Number(orderRaw) : idx + 1;

    const perLang = {};
    let optionCount = null;

    for (const lang of SUPPORTED_LANGS) {
      const prompt = cellStr(row[`prompt_${lang}`]);
      // Collect opt1..opt10 for this language.
      const opts = [];
      for (let n = 1; n <= MAX_OPTIONS; n++) {
        const c = row[`opt${n}_${lang}`];
        const val = cellStr(c);
        if (val !== '') opts[n - 1] = val;
        else if (opts.length >= n) opts[n - 1] = '';
      }
      // Trim trailing empties.
      const cleanOpts = [];
      for (let n = 0; n < MAX_OPTIONS; n++) {
        const v = cellStr(row[`opt${n + 1}_${lang}`]);
        if (v !== '') cleanOpts.push(v);
      }
      const anyContent = prompt !== '' || cleanOpts.length > 0;
      if (!anyContent) continue; // language not present for this question

      if (prompt === '') {
        errors.push({ scope: 'questions', row: rowNo, message: `${lang.toUpperCase()}: prompt is empty but options are filled.` });
        continue;
      }
      if (cleanOpts.length < MIN_OPTIONS) {
        errors.push({ scope: 'questions', row: rowNo, message: `${lang.toUpperCase()}: needs at least ${MIN_OPTIONS} options.` });
        continue;
      }
      if (optionCount === null) optionCount = cleanOpts.length;
      else if (cleanOpts.length !== optionCount) {
        errors.push({ scope: 'questions', row: rowNo, message: `${lang.toUpperCase()}: option count (${cleanOpts.length}) differs from other languages (${optionCount}).` });
        continue;
      }
      const entry = { prompt, options: cleanOpts };
      const explanation = cellStr(row[`explanation_${lang}`]);
      if (explanation) entry.explanation = explanation;
      perLang[lang] = entry;
    }

    if (Object.keys(perLang).length === 0) {
      errors.push({ scope: 'questions', row: rowNo, message: 'No language has a prompt + options.' });
      return;
    }
    if (!Number.isInteger(points) || points < 1 || points > MAX_POINTS) {
      errors.push({ scope: 'questions', row: rowNo, message: `points must be an integer 1..${MAX_POINTS}.` });
    }
    if (!Number.isInteger(correct) || correct < 1 || (optionCount && correct > optionCount)) {
      errors.push({ scope: 'questions', row: rowNo, message: `correct must be an integer 1..${optionCount || MAX_OPTIONS} (the correct option number).` });
    }

    questions.push({
      rowNo,
      order: Number.isInteger(order) ? order : idx + 1,
      points,
      correctIndex: (Number.isInteger(correct) ? correct : 1) - 1, // 0-based
      optionCount: optionCount || 0,
      translations: perLang,
    });
  });

  // Sort by order, then reassign sequential 1..N for storage.
  questions.sort((a, b) => a.order - b.order);
  questions.forEach((q, i) => { q.orderIndex = i + 1; });

  const ok = errors.length === 0 && Object.keys(translations).length > 0 && questions.length > 0;
  return {
    ok,
    errors,
    quiz: {
      translations,
      questionCount: questions.length,
      languages: Object.keys(translations),
      questions,
    },
  };
}

/** Build a human-friendly preview (no DB writes). */
function preview(buffer) {
  const parsed = parseWorkbook(buffer);
  // Compact preview rows for the UI.
  const previewQuestions = (parsed.quiz?.questions || []).map((q) => {
    const repLang = q.translations[DEFAULT_LANG] ? DEFAULT_LANG : Object.keys(q.translations)[0];
    const rep = q.translations[repLang] || { prompt: '', options: [] };
    return {
      orderIndex: q.orderIndex,
      points: q.points,
      languages: Object.keys(q.translations),
      prompt: rep.prompt,
      options: rep.options,
      correctIndex: q.correctIndex,
      hasExplanation: Object.values(q.translations).some((t) => t.explanation),
    };
  });

  const repLang = parsed.quiz && (parsed.quiz.translations[DEFAULT_LANG] ? DEFAULT_LANG : Object.keys(parsed.quiz.translations)[0]);
  return {
    ok: parsed.ok,
    errors: parsed.errors,
    summary: parsed.quiz ? {
      title: repLang ? parsed.quiz.translations[repLang].title : '(none)',
      languages: parsed.quiz.languages,
      questionCount: parsed.quiz.questionCount,
    } : null,
    questions: previewQuestions,
    // Echo back the normalized payload so commit doesn't need the file again.
    payload: parsed.ok ? parsed.quiz : null,
  };
}

/**
 * Commit a previously-previewed payload. Re-validates structurally, then
 * writes the quiz + translations + questions + options + option translations
 * in ONE transaction (all-or-nothing).
 */
async function commit(payload, { adminId } = {}) {
  if (!payload || typeof payload !== 'object') throw new HttpError(400, 'Missing import payload');
  const { translations, questions } = payload;
  if (!translations || Object.keys(translations).length === 0) {
    throw new HttpError(400, 'Import payload has no quiz translations');
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new HttpError(400, 'Import payload has no questions');
  }

  // Representative language for legacy columns.
  const repQuizLang = translations[DEFAULT_LANG] ? DEFAULT_LANG : Object.keys(translations)[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Quiz row + translations.
    const { rows: qRows } = await client.query(
      `INSERT INTO quizzes (title, description, created_by)
       VALUES ($1, $2, $3) RETURNING id, title, created_at`,
      [translations[repQuizLang].title, translations[repQuizLang].description || null, adminId || null]
    );
    const quizId = qRows[0].id;

    for (const [lang, val] of Object.entries(translations)) {
      if (!isSupported(lang)) continue;
      await client.query(
        `INSERT INTO quiz_translations (quiz_id, lang, title, description) VALUES ($1, $2, $3, $4)`,
        [quizId, lang, val.title, val.description || null]
      );
    }

    // Questions.
    for (const q of questions) {
      const perLang = q.translations;
      const repLang = perLang[DEFAULT_LANG] ? DEFAULT_LANG : Object.keys(perLang)[0];
      const rep = perLang[repLang];
      const optionCount = rep.options.length;
      const correctIndex = Number(q.correctIndex);
      if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= optionCount) {
        throw new HttpError(400, `Question ${q.orderIndex}: correct option out of range`);
      }

      const { rows: insQ } = await client.query(
        `INSERT INTO questions (quiz_id, order_index, prompt, points) VALUES ($1, $2, $3, $4) RETURNING id`,
        [quizId, q.orderIndex, rep.prompt, q.points]
      );
      const questionId = insQ[0].id;

      for (const [lang, val] of Object.entries(perLang)) {
        await client.query(
          `INSERT INTO question_translations (question_id, lang, prompt, explanation) VALUES ($1, $2, $3, $4)`,
          [questionId, lang, val.prompt, val.explanation || null]
        );
      }

      for (let i = 0; i < optionCount; i++) {
        const { rows: insO } = await client.query(
          `INSERT INTO answer_options (question_id, order_index, text, is_correct) VALUES ($1, $2, $3, $4) RETURNING id`,
          [questionId, i + 1, rep.options[i], i === correctIndex]
        );
        const optionId = insO[0].id;
        for (const [lang, val] of Object.entries(perLang)) {
          await client.query(
            `INSERT INTO answer_option_translations (option_id, lang, text) VALUES ($1, $2, $3)`,
            [optionId, lang, val.options[i]]
          );
        }
      }
    }

    await client.query('COMMIT');
    return { id: quizId, title: qRows[0].title, createdAt: qRows[0].created_at, questionCount: questions.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { preview, commit, parseWorkbook };
