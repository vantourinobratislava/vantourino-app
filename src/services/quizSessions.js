'use strict';

const pool = require('../db/pool');
const HttpError = require('../utils/httpError');
const { generate: generateCode } = require('../utils/sessionCode');
const quizzes = require('./quizzes');
const audioLibrary = require('./audioLibrary');
const {
  SessionStatus,
  QuestionStatus,
  CAN_START_QUESTION_FROM,
  isTerminal,
} = require('../utils/statuses');
const { SUPPORTED_LANGS, normalizeLang } = require('../utils/languages');

// Resolve a { lang: text } map to the requested language with fallback.
async function resolvePromptByLang(client, questionId, want) {
  const { rows } = await (client || pool).query(
    `SELECT lang, prompt FROM question_translations WHERE question_id = $1`,
    [questionId]
  );
  const byLang = {};
  for (const r of rows) byLang[r.lang] = r.prompt;
  if (byLang[want] != null) return byLang[want];
  for (const l of SUPPORTED_LANGS) if (byLang[l] != null) return byLang[l];
  const ks = Object.keys(byLang);
  return ks.length ? byLang[ks[0]] : null;
}

// Resolve the explanation for a question to the requested language (fallback).
// Returns null when no explanation exists in any language (it's optional).
async function resolveExplanationByLang(questionId, want) {
  const { rows } = await pool.query(
    `SELECT lang, explanation FROM question_translations
      WHERE question_id = $1 AND explanation IS NOT NULL AND explanation <> ''`,
    [questionId]
  );
  if (rows.length === 0) return null;
  const byLang = {};
  for (const r of rows) byLang[r.lang] = r.explanation;
  if (byLang[want] != null) return byLang[want];
  for (const l of SUPPORTED_LANGS) if (byLang[l] != null) return byLang[l];
  const ks = Object.keys(byLang);
  return ks.length ? byLang[ks[0]] : null;
}

// Resolve option texts for a set of option ids → Map(optionId → text).
async function resolveOptionTexts(optionIds, want) {
  const map = new Map();
  if (!optionIds.length) return map;
  const { rows } = await pool.query(
    `SELECT option_id, lang, text FROM answer_option_translations
      WHERE option_id = ANY($1::int[])`,
    [optionIds]
  );
  const byOpt = new Map();
  for (const r of rows) {
    if (!byOpt.has(r.option_id)) byOpt.set(r.option_id, {});
    byOpt.get(r.option_id)[r.lang] = r.text;
  }
  for (const [oid, byLang] of byOpt.entries()) {
    let chosen = byLang[want];
    if (chosen == null) for (const l of SUPPORTED_LANGS) { if (byLang[l] != null) { chosen = byLang[l]; break; } }
    if (chosen == null) { const ks = Object.keys(byLang); chosen = ks.length ? byLang[ks[0]] : null; }
    map.set(oid, chosen);
  }
  return map;
}

const MAX_CODE_ATTEMPTS = 6;
const MIN_ANSWER_TIME = 5;
const MAX_ANSWER_TIME = 3600;
const DEFAULT_ANSWER_TIME = 30;

function normalizeAnswerTime(input) {
  if (input === undefined || input === null) return DEFAULT_ANSWER_TIME;
  const n = Number(input);
  if (!Number.isInteger(n) || n < MIN_ANSWER_TIME || n > MAX_ANSWER_TIME) {
    throw new HttpError(
      400,
      `answerTimeSeconds must be an integer between ${MIN_ANSWER_TIME} and ${MAX_ANSWER_TIME}`
    );
  }
  return n;
}

/**
 * Create a quiz session.
 * - {quizId} → use existing quiz.
 * - {title, description?} → v2 compat: create the quiz inline.
 */
async function create({ quizId, title, description, answerTimeSeconds, adminId }) {
  const answerTime = normalizeAnswerTime(answerTimeSeconds);

  if (!quizId && !title) {
    throw new HttpError(400, 'Either quizId or title is required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let quiz;
    if (quizId) {
      const id = Number(quizId);
      if (!Number.isInteger(id) || id < 1) {
        throw new HttpError(400, 'quizId must be a positive integer');
      }
      const { rows } = await client.query(
        `SELECT id, title, description, created_at FROM quizzes WHERE id = $1 LIMIT 1`,
        [id]
      );
      if (!rows[0]) throw new HttpError(404, 'Quiz not found');
      quiz = rows[0];
    } else {
      // v2 compat: create quiz inline.
      quiz = await quizzes.create({ title, description, adminId });
    }

    let sessionRow = null;
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const code = generateCode();
      try {
        const { rows } = await client.query(
          `INSERT INTO quiz_sessions
             (session_code, quiz_id, created_by, answer_time_seconds, status)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, session_code, quiz_id, status, answer_time_seconds,
                     created_at, started_at, ended_at, created_by,
                     current_question_id, current_question_status, current_question_deadline`,
          [code, quiz.id, adminId, answerTime, SessionStatus.PENDING]
        );
        sessionRow = rows[0];
        break;
      } catch (err) {
        if (err.code === '23505') continue;
        throw err;
      }
    }
    if (!sessionRow) {
      throw new HttpError(500, 'Could not allocate a unique session code');
    }

    await client.query('COMMIT');
    return { session: sessionRow, quiz };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getByCode(sessionCode) {
  const { rows } = await pool.query(
    `SELECT qs.id, qs.session_code, qs.quiz_id, qs.status, qs.answer_time_seconds,
            qs.created_at, qs.started_at, qs.ended_at,
            qs.current_question_id, qs.current_question_status, qs.current_question_deadline,
            qs.paused_at, qs.remaining_ms,
            qs.created_by,
            cre.username AS created_by_username,
            q.title       AS quiz_title,
            q.description AS quiz_description
       FROM quiz_sessions qs
       JOIN quizzes q ON q.id = qs.quiz_id
       LEFT JOIN admins cre ON cre.id = qs.created_by
      WHERE qs.session_code = $1
      LIMIT 1`,
    [sessionCode]
  );
  return rows[0] || null;
}

async function listTeams(sessionId) {
  const { rows } = await pool.query(
    `SELECT id, name, joined_at FROM teams WHERE session_id = $1 ORDER BY joined_at ASC`,
    [sessionId]
  );
  return rows;
}

// ------------ Lifecycle ------------

/** pending → active. */
async function startSession(sessionCode) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, status, quiz_id FROM quiz_sessions
        WHERE session_code = $1 FOR UPDATE`,
      [sessionCode]
    );
    if (!rows[0]) throw new HttpError(404, 'Session not found');
    const session = rows[0];

    if (session.status !== SessionStatus.PENDING) {
      throw new HttpError(409, `Cannot start session in status: ${session.status}`);
    }

    const { rows: qCount } = await client.query(
      `SELECT COUNT(*)::int AS count FROM questions WHERE quiz_id = $1`,
      [session.quiz_id]
    );
    if (qCount[0].count === 0) {
      throw new HttpError(409, 'Quiz has no questions; add questions before starting');
    }

    await client.query(
      `UPDATE quiz_sessions
          SET status = $2, started_at = NOW()
        WHERE id = $1`,
      [session.id, SessionStatus.ACTIVE]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return getByCode(sessionCode);
}

/**
 * Make a specific question current and live.
 * Allowed only from session statuses active/round_results, and only if no
 * other question is currently live for this session.
 */
async function startQuestion(sessionCode, questionId) {
  const qid = Number(questionId);
  if (!Number.isInteger(qid) || qid < 1) {
    throw new HttpError(400, 'questionId must be a positive integer');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: sRows } = await client.query(
      `SELECT id, status, quiz_id, answer_time_seconds,
              current_question_id, current_question_status
         FROM quiz_sessions WHERE session_code = $1 FOR UPDATE`,
      [sessionCode]
    );
    if (!sRows[0]) throw new HttpError(404, 'Session not found');
    const session = sRows[0];

    if (isTerminal(session.status)) {
      throw new HttpError(409, `Session is ${session.status}; no further questions can be started`);
    }
    if (!CAN_START_QUESTION_FROM.has(session.status)) {
      throw new HttpError(409, `Cannot start a question in session status: ${session.status}`);
    }
    if (session.current_question_status === QuestionStatus.LIVE) {
      throw new HttpError(409, 'Another question is currently live; finish it first');
    }

    const { rows: qRows } = await client.query(
      `SELECT id, quiz_id, order_index, kind FROM questions WHERE id = $1 LIMIT 1`,
      [qid]
    );
    if (!qRows[0]) throw new HttpError(404, 'Question not found');
    if (qRows[0].quiz_id !== session.quiz_id) {
      throw new HttpError(400, 'Question does not belong to this session\'s quiz');
    }
    // Treat as a contest (no timer) if kind says so, OR — robustness against a
    // stale/missing kind — if the item has no answer options at all. Only
    // contests lack options, so this can never misclassify a real question.
    let isContest = qRows[0].kind === 'contest';
    if (!isContest) {
      const { rows: optCount } = await client.query(
        `SELECT COUNT(*)::int AS c FROM answer_options WHERE question_id = $1`,
        [qid]
      );
      if (optCount[0].c === 0) isContest = true;
    }

    // Already finished in this session?
    const { rows: rrRows } = await client.query(
      `SELECT 1 FROM round_results WHERE session_id = $1 AND question_id = $2 LIMIT 1`,
      [session.id, qid]
    );
    if (rrRows[0]) {
      throw new HttpError(409, 'Question has already been finished in this session');
    }

    // Contests have no timer: deadline stays NULL, so the answer guard rejects
    // team submissions and expireIfDue() never auto-finishes them. Normal
    // questions get the usual countdown.
    const { rows: updated } = await client.query(
      `UPDATE quiz_sessions
         SET status = $4,
             current_question_id = $2,
             current_question_status = $5,
             current_question_deadline = CASE WHEN $6 THEN NULL
                                              ELSE NOW() + (($3::int || ' seconds')::interval) END,
             paused_at = NULL,
             remaining_ms = NULL
       WHERE id = $1
       RETURNING current_question_deadline`,
      [session.id, qid, session.answer_time_seconds, SessionStatus.ACTIVE, QuestionStatus.LIVE, isContest]
    );

    await client.query('COMMIT');
    return { questionId: qid, deadline: updated[0].current_question_deadline, kind: qRows[0].kind };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Pause the currently-live question. In one transaction (FOR UPDATE):
 *   - verify the given question is the current one AND status is 'live'
 *   - compute remaining_ms = max(0, deadline - NOW())
 *   - set status='paused', paused_at=NOW(), remaining_ms=<computed>,
 *     deadline=NULL
 *
 * With deadline NULL and status 'paused', the answer-insert guard (requires
 * deadline > NOW()) rejects answers, and expireIfDue() (fires only on 'live')
 * won't auto-finish. So pause is enforced purely by the state, not the UI.
 */
async function pauseQuestion(sessionCode, questionId) {
  const qid = Number(questionId);
  if (!Number.isInteger(qid) || qid < 1) throw new HttpError(400, 'invalid questionId');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: sRows } = await client.query(
      `SELECT id, current_question_id, current_question_status,
              current_question_deadline
         FROM quiz_sessions WHERE session_code = $1 FOR UPDATE`,
      [sessionCode]
    );
    if (!sRows[0]) throw new HttpError(404, 'Session not found');
    const s = sRows[0];
    if (s.current_question_id !== qid) {
      throw new HttpError(409, 'This is not the current question');
    }
    if (s.current_question_status !== QuestionStatus.LIVE) {
      throw new HttpError(409, `Question is not live (status: ${s.current_question_status || 'none'})`);
    }

    // Contests have no timer, so there is nothing to pause.
    const { rows: kRows } = await client.query(
      `SELECT kind FROM questions WHERE id = $1`,
      [qid]
    );
    if (kRows[0] && kRows[0].kind === 'contest') {
      throw new HttpError(409, 'Contests have no timer and cannot be paused');
    }

    const { rows: updated } = await client.query(
      `UPDATE quiz_sessions
         SET current_question_status = $2,
             paused_at = NOW(),
             remaining_ms = GREATEST(0, CAST((EXTRACT(EPOCH FROM current_question_deadline) - EXTRACT(EPOCH FROM NOW())) * 1000 AS INTEGER)),
             current_question_deadline = NULL
       WHERE id = $1
       RETURNING remaining_ms`,
      [s.id, QuestionStatus.PAUSED]
    );

    await client.query('COMMIT');
    return { questionId: qid, status: QuestionStatus.PAUSED, remainingMs: updated[0].remaining_ms };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resume a paused question. In one transaction (FOR UPDATE):
 *   - verify the given question is current AND status is 'paused'
 *   - set deadline = NOW() + remaining_ms, status='live', clear paused_at/remaining_ms
 *
 * The timer continues from the time that was left when paused (never a full
 * reset). Late-answer rejection and auto-finish resume working against the new
 * deadline automatically. If remaining_ms was 0, the question is immediately
 * due and the next poll will auto-finish it (correct behavior).
 */
async function resumeQuestion(sessionCode, questionId) {
  const qid = Number(questionId);
  if (!Number.isInteger(qid) || qid < 1) throw new HttpError(400, 'invalid questionId');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: sRows } = await client.query(
      `SELECT id, current_question_id, current_question_status, remaining_ms
         FROM quiz_sessions WHERE session_code = $1 FOR UPDATE`,
      [sessionCode]
    );
    if (!sRows[0]) throw new HttpError(404, 'Session not found');
    const s = sRows[0];
    if (s.current_question_id !== qid) {
      throw new HttpError(409, 'This is not the current question');
    }
    if (s.current_question_status !== QuestionStatus.PAUSED) {
      throw new HttpError(409, `Question is not paused (status: ${s.current_question_status || 'none'})`);
    }

    const remaining = Number.isInteger(s.remaining_ms) ? s.remaining_ms : 0;
    const { rows: updated } = await client.query(
      `UPDATE quiz_sessions
         SET current_question_status = $2,
             current_question_deadline = NOW() + (($3::int || ' milliseconds')::interval),
             paused_at = NULL,
             remaining_ms = NULL
       WHERE id = $1
       RETURNING current_question_deadline`,
      [s.id, QuestionStatus.LIVE, remaining]
    );

    await client.query('COMMIT');
    return { questionId: qid, status: QuestionStatus.LIVE, deadline: updated[0].current_question_deadline };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Award contest points to teams. Validates the current item is a contest that
 * is live in this session, and that each award is an integer in [0, maxPoints].
 * Upserts one answers row per team (option_id NULL, points_awarded = score) —
 * idempotent, so re-awarding overwrites. finishQuestion() later reads these.
 *
 * `awards` = [{ teamId, points }]. Teams not listed simply keep their previous
 * award (or none → 0 at finish).
 */
async function awardContestPoints(sessionCode, questionId, awards) {
  const qid = Number(questionId);
  if (!Number.isInteger(qid) || qid < 1) throw new HttpError(400, 'invalid questionId');
  if (!Array.isArray(awards)) throw new HttpError(400, 'awards must be an array');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: sRows } = await client.query(
      `SELECT id, current_question_id, current_question_status
         FROM quiz_sessions WHERE session_code = $1 FOR UPDATE`,
      [sessionCode]
    );
    if (!sRows[0]) throw new HttpError(404, 'Session not found');
    const session = sRows[0];
    if (session.current_question_id !== qid) {
      throw new HttpError(409, 'This is not the current item');
    }
    if (session.current_question_status !== QuestionStatus.LIVE) {
      throw new HttpError(409, `Item is not open for scoring (status: ${session.current_question_status || 'none'})`);
    }

    const { rows: qRows } = await client.query(
      `SELECT id, points, kind FROM questions WHERE id = $1`,
      [qid]
    );
    if (!qRows[0]) throw new HttpError(404, 'Item not found');
    if (qRows[0].kind === 'audio') throw new HttpError(400, 'Audio items are not scored');
    // Accept the item as a contest if kind says so OR (robustness against a
    // stale/missing kind) it has no answer options — only contests lack
    // options, so a real question can never pass this.
    let isContest = qRows[0].kind === 'contest';
    if (!isContest) {
      const { rows: optCount } = await client.query(
        `SELECT COUNT(*)::int AS c FROM answer_options WHERE question_id = $1`,
        [qid]
      );
      isContest = optCount[0].c === 0;
    }
    if (!isContest) throw new HttpError(400, 'This item is not a contest');
    const maxPoints = qRows[0].points;

    // Valid team set for this session.
    const { rows: teamRows } = await client.query(
      `SELECT id FROM teams WHERE session_id = $1`,
      [session.id]
    );
    const validTeams = new Set(teamRows.map((t) => t.id));

    for (const a of awards) {
      const teamId = Number(a.teamId);
      const pts = Number(a.points);
      if (!validTeams.has(teamId)) {
        throw new HttpError(400, `Team ${a.teamId} is not in this session`);
      }
      if (!Number.isInteger(pts) || pts < 0 || pts > maxPoints) {
        throw new HttpError(400, `Award for team ${teamId} must be an integer between 0 and ${maxPoints}`);
      }
      // Upsert the award row (option_id NULL for contests).
      await client.query(
        `INSERT INTO answers (session_id, question_id, team_id, option_id, points_awarded)
         VALUES ($1, $2, $3, NULL, $4)
         ON CONFLICT (session_id, question_id, team_id)
         DO UPDATE SET points_awarded = EXCLUDED.points_awarded`,
        [session.id, qid, teamId, pts]
      );
    }

    await client.query('COMMIT');
    return { ok: true, count: awards.length, maxPoints };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Auto-finish the current question if its deadline has passed.
 *
 * This is the SINGLE central trigger for timeout: it reuses finishQuestion()
 * (same scoring + state transition as a manual Finish), so there's no
 * duplicated logic. Called at the start of every read path; because both admin
 * and team poll those reads, the question closes automatically the moment any
 * client polls after the deadline.
 *
 * Idempotent and race-safe: finishQuestion() locks the session row FOR UPDATE
 * and only proceeds when current_question_status is still 'live'. If two polls
 * arrive at once, the first finishes the question; the second finds it no
 * longer live and is a no-op. Any 409 from a lost race is swallowed here.
 *
 * Returns true if it finished a question, false otherwise.
 */
async function expireIfDue(sessionCode) {
  // Cheap pre-check: only attempt when a question is live AND past deadline.
  const { rows } = await pool.query(
    `SELECT current_question_id
       FROM quiz_sessions
      WHERE session_code = $1
        AND current_question_status = $2
        AND current_question_deadline IS NOT NULL
        AND current_question_deadline <= NOW()
      LIMIT 1`,
    [sessionCode, QuestionStatus.LIVE]
  );
  if (!rows[0] || !rows[0].current_question_id) return false;

  try {
    await finishQuestion(sessionCode, rows[0].current_question_id);
    return true;
  } catch (err) {
    // A concurrent poll (or the admin's manual Finish) already closed it.
    if (err instanceof HttpError && err.status === 409) return false;
    throw err;
  }
}

/**
 * Close the current question and score it. Single transaction containing:
 *   1. lock session row
 *   2. verify state (question is current, question is live)
 *   3. evaluate correctness on answers
 *   4. award points on answers
 *   5. compute per-round ranking + cumulative totals
 *   6. write round_results
 *   7. if this was the last question: write final_results, set session=finished
 *      else: set session=round_results
 *   8. set current_question_status=closed
 *
 * Either all of this happens or none of it does.
 */
async function finishQuestion(sessionCode, questionId) {
  const qid = Number(questionId);
  if (!Number.isInteger(qid) || qid < 1) {
    throw new HttpError(400, 'questionId must be a positive integer');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock session
    const { rows: sRows } = await client.query(
      `SELECT id, status, quiz_id, current_question_id, current_question_status
         FROM quiz_sessions WHERE session_code = $1 FOR UPDATE`,
      [sessionCode]
    );
    if (!sRows[0]) throw new HttpError(404, 'Session not found');
    const session = sRows[0];

    // 2. State validation
    if (isTerminal(session.status)) {
      throw new HttpError(409, `Session is ${session.status}; cannot finish a question`);
    }
    if (session.current_question_id !== qid) {
      throw new HttpError(409, 'This is not the current question');
    }
    if (session.current_question_status !== QuestionStatus.LIVE) {
      throw new HttpError(
        409,
        `Question is not live (current status: ${session.current_question_status})`
      );
    }

    const { rows: qRows } = await client.query(
      `SELECT q.id, q.points, q.quiz_id, q.order_index, q.kind,
              ao.id AS correct_option_id
         FROM questions q
         LEFT JOIN answer_options ao
           ON ao.question_id = q.id AND ao.is_correct = TRUE
        WHERE q.id = $1`,
      [qid]
    );
    const question = qRows[0];
    if (!question) throw new HttpError(500, 'Question vanished');

    // AUDIO items are unscored and have no results step. Finishing one writes
    // NO answers/round_results — it simply closes the item and advances. Must be
    // checked BEFORE the contest/no-options detection (audio also has no options).
    if (question.kind === 'audio') {
      const { rows: maxRowsA } = await client.query(
        `SELECT MAX(order_index) AS max_oi FROM questions WHERE quiz_id = $1`,
        [session.quiz_id]
      );
      const isLastAudio = maxRowsA[0].max_oi === question.order_index;
      if (isLastAudio) {
        // Last item is audio: finalize standings from existing round_results
        // (audio contributes nothing) and finish the session.
        await client.query(
          `INSERT INTO final_results (session_id, team_id, total_points, rank)
           SELECT
             $1, t.id,
             COALESCE(SUM(rr.points_awarded), 0)::int,
             RANK() OVER (ORDER BY COALESCE(SUM(rr.points_awarded), 0) DESC, t.joined_at ASC)
           FROM teams t
             LEFT JOIN round_results rr ON rr.team_id = t.id AND rr.session_id = $1
           WHERE t.session_id = $1
           GROUP BY t.id, t.joined_at
           ON CONFLICT (session_id, team_id) DO NOTHING`,
          [session.id]
        );
        await client.query(
          `UPDATE quiz_sessions
              SET status = $2, current_question_status = $3, ended_at = NOW()
            WHERE id = $1`,
          [session.id, SessionStatus.FINISHED, QuestionStatus.CLOSED]
        );
      } else {
        // Not last: clear the current item and return to ACTIVE so the admin
        // sees the "next item" panel directly — no round-results screen.
        await client.query(
          `UPDATE quiz_sessions
              SET status = $2,
                  current_question_status = NULL,
                  current_question_id = NULL,
                  current_question_deadline = NULL,
                  paused_at = NULL,
                  remaining_ms = NULL
            WHERE id = $1`,
          [session.id, SessionStatus.ACTIVE]
        );
      }
      await client.query('COMMIT');
      return { isLast: isLastAudio, audio: true };
    }

    // An item is scored as a contest if its kind says so, OR (robustness
    // against a stale/missing kind) if it has no answer options at all — only
    // contests lack options. This guarantees a contest never falls into the
    // correct-answer scoring path and never throws "no correct answer marked".
    let isContest = question.kind === 'contest';
    if (!isContest && !question.correct_option_id) {
      const { rows: optCount } = await client.query(
        `SELECT COUNT(*)::int AS c FROM answer_options WHERE question_id = $1`,
        [qid]
      );
      if (optCount[0].c === 0) isContest = true;
    }

    if (isContest) {
      // Contest: no correct answer. The admin's awards are already stored on
      // the answers rows (option_id NULL, points_awarded = N) via award().
      // Clamp any award to [0, max] defensively and stamp finalized_at.
      await client.query(
        `UPDATE answers
            SET is_correct = NULL,
                points_awarded = LEAST(GREATEST(COALESCE(points_awarded, 0), 0), $1),
                finalized_at = NOW()
          WHERE session_id = $2 AND question_id = $3`,
        [question.points, session.id, qid]
      );
    } else {
      if (!question.correct_option_id) {
        throw new HttpError(500, 'Question has no correct answer marked');
      }
      // 3 + 4. Evaluate correctness + award points on submitted answers
      await client.query(
        `UPDATE answers
            SET is_correct     = (option_id = $1),
                points_awarded = CASE WHEN option_id = $1 THEN $2 ELSE 0 END,
                finalized_at   = NOW()
          WHERE session_id = $3 AND question_id = $4`,
        [question.correct_option_id, question.points, session.id, qid]
      );
    }

    // 5 + 6. Compute per-round rank + cumulative totals, then materialize
    // one round_results row per team in the session.
    //   - answered = TRUE iff the team submitted an answer for this question
    //   - cumulative_points = sum of prior round_results + this round's award
    //   - rank = RANK() over cumulative_points DESC, joined_at ASC (ties share)
    await client.query(
      `INSERT INTO round_results
         (session_id, question_id, team_id, answered, is_correct, points_awarded, rank, cumulative_points)
       SELECT
         $1::int, $2::int, t.id,
         (a.id IS NOT NULL)                                       AS answered,
         COALESCE(a.is_correct, FALSE)                            AS is_correct,
         COALESCE(a.points_awarded, 0)                            AS points_awarded,
         RANK() OVER (
           ORDER BY (COALESCE(prev.total, 0) + COALESCE(a.points_awarded, 0)) DESC,
                    t.joined_at ASC
         )                                                         AS rank,
         (COALESCE(prev.total, 0) + COALESCE(a.points_awarded, 0)) AS cumulative_points
       FROM teams t
         LEFT JOIN answers a
           ON a.team_id = t.id AND a.session_id = $1 AND a.question_id = $2
         LEFT JOIN (
           SELECT team_id, SUM(points_awarded)::int AS total
             FROM round_results
            WHERE session_id = $1
            GROUP BY team_id
         ) prev ON prev.team_id = t.id
       WHERE t.session_id = $1`,
      [session.id, qid]
    );

    // 7. Last question?
    const { rows: maxRows } = await client.query(
      `SELECT MAX(order_index) AS max_oi FROM questions WHERE quiz_id = $1`,
      [session.quiz_id]
    );
    const isLast = maxRows[0].max_oi === question.order_index;

    if (isLast) {
      // Write final_results in the SAME transaction as the last round's scoring.
      await client.query(
        `INSERT INTO final_results (session_id, team_id, total_points, rank)
         SELECT
           $1, t.id,
           COALESCE(SUM(rr.points_awarded), 0)::int,
           RANK() OVER (
             ORDER BY COALESCE(SUM(rr.points_awarded), 0) DESC, t.joined_at ASC
           )
         FROM teams t
           LEFT JOIN round_results rr ON rr.team_id = t.id AND rr.session_id = $1
         WHERE t.session_id = $1
         GROUP BY t.id, t.joined_at
         ON CONFLICT (session_id, team_id) DO NOTHING`,
        [session.id]
      );
      await client.query(
        `UPDATE quiz_sessions
            SET status = $2,
                current_question_status = $3,
                ended_at = NOW()
          WHERE id = $1`,
        [session.id, SessionStatus.FINISHED, QuestionStatus.CLOSED]
      );
    } else {
      await client.query(
        `UPDATE quiz_sessions
            SET status = $2,
                current_question_status = $3
          WHERE id = $1`,
        [session.id, SessionStatus.ROUND_RESULTS, QuestionStatus.CLOSED]
      );
    }

    await client.query('COMMIT');
    return { isLast };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Close a session. Idempotent. If final_results aren't yet present (admin
 * is closing before reaching the last question), compute them now from
 * whatever round_results exist.
 */
async function closeSession(sessionCode) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, status FROM quiz_sessions WHERE session_code = $1 FOR UPDATE`,
      [sessionCode]
    );
    if (!rows[0]) throw new HttpError(404, 'Session not found');
    const session = rows[0];

    if (session.status === SessionStatus.CLOSED) {
      await client.query('COMMIT');
      return; // idempotent — nothing more to do
    }

    await client.query(
      `INSERT INTO final_results (session_id, team_id, total_points, rank)
       SELECT
         $1, t.id,
         COALESCE(SUM(rr.points_awarded), 0)::int,
         RANK() OVER (
           ORDER BY COALESCE(SUM(rr.points_awarded), 0) DESC, t.joined_at ASC
         )
       FROM teams t
         LEFT JOIN round_results rr ON rr.team_id = t.id AND rr.session_id = $1
       WHERE t.session_id = $1
       GROUP BY t.id, t.joined_at
       ON CONFLICT (session_id, team_id) DO NOTHING`,
      [session.id]
    );

    // Wipe the question pointer state on close. Anything that tries to
    // submit/finish after this will see NULL current_question_status and fail.
    await client.query(
      `UPDATE quiz_sessions
          SET status = $2,
              current_question_status = NULL,
              current_question_deadline = NULL,
              ended_at = COALESCE(ended_at, NOW())
        WHERE id = $1`,
      [session.id, SessionStatus.CLOSED]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ------------ Read views ------------

/**
 * Returns the currently-pointed question.
 *
 * Public (forAdmin=false): NEVER exposes is_correct on options. Returns null
 *   unless the question is 'live' — we don't leak unstarted or closed-status
 *   questions to teams.
 * Admin: full visibility, always returns if pointer is set.
 */
async function getCurrentQuestion(sessionCode, { forAdmin = false, lang, audioLang } = {}) {
  // Auto-close the question first if its timer has expired, so the read below
  // reflects the post-timeout state (round_results) and never serves a live
  // question past its deadline.
  await expireIfDue(sessionCode);

  const session = await getByCode(sessionCode);
  if (!session) throw new HttpError(404, 'Session not found');
  const want = normalizeLang(lang);

  if (!session.current_question_id) {
    return { session, question: null };
  }
  // Teams see the question while it is LIVE or PAUSED (paused stays on screen,
  // frozen). Unstarted/closed questions are not exposed to teams. Answer
  // submission is gated separately (paused → rejected by the answer guard).
  if (!forAdmin &&
      session.current_question_status !== QuestionStatus.LIVE &&
      session.current_question_status !== QuestionStatus.PAUSED) {
    return { session, question: null };
  }

  const { rows: qRows } = await pool.query(
    `SELECT id, quiz_id, order_index, prompt, points, kind, audio_url, audio_guide_id FROM questions WHERE id = $1 LIMIT 1`,
    [session.current_question_id]
  );
  if (!qRows[0]) return { session, question: null };
  const q = qRows[0];

  const optCols = forAdmin
    ? 'id, order_index, text, is_correct'
    : 'id, order_index, text'; // public: no is_correct
  const { rows: oRows } = await pool.query(
    `SELECT ${optCols} FROM answer_options WHERE question_id = $1 ORDER BY order_index ASC`,
    [q.id]
  );

  // Resolve translations (fallback to legacy column text if none).
  const promptResolved = (await resolvePromptByLang(null, q.id, want)) ?? q.prompt;
  const explanationResolved = await resolveExplanationByLang(q.id, want);
  const textMap = await resolveOptionTexts(oRows.map((o) => o.id), want);

  // Audio first (it also has no options, so must be detected before the contest
  // fallback). Then contest (kind says so, or — robustness — no options).
  const isAudio = q.kind === 'audio';
  const isContest = !isAudio && (q.kind === 'contest' || oRows.length === 0);

  // Audio source resolution (B2.2). Priority:
  //   1) linked guide → resolveVariant(guide, want) → /api/audio/<variant>/stream
  //   2) raw audio_url stored on the question (Phase A fallback)
  //   3) null → admin/team see a clear "no audio set" empty state
  // We resolve at read time so guide deletions / variant attaches take effect
  // for already-running sessions on the very next poll.
  let resolvedAudioUrl = null;
  let audioSource = null; // { guideId, variantId, usedLang, fellBack } when guide-resolved
  if (isAudio) {
    if (q.audio_guide_id) {
      try {
        // Use the RAW requested lang for variant resolution: audio supports a
        // wider language set (en/de/sk/it/es/fr) than the UI (en/sk/de), so
        // normalizing here would collapse it/es/fr → en and skip valid variants.
        // resolveVariant handles unsupported/empty lang via its own fallback chain.
        //
        // B2.3: when an admin passes an explicit audioLang override (the live
        // language switcher), prefer it over the UI lang. Anything else
        // (unsupported value, public team request) falls back to the UI lang.
        let audioWant;
        if (forAdmin && audioLibrary.isSupportedAudioLang(audioLang)) {
          audioWant = String(audioLang).toLowerCase();
        } else if (typeof lang === 'string' && lang.trim()) {
          audioWant = lang.trim().toLowerCase();
        } else {
          audioWant = want;
        }
        const res = await audioLibrary.resolveVariant(q.audio_guide_id, audioWant);
        if (res && res.variant && res.variant.id) {
          resolvedAudioUrl = `/api/audio/${res.variant.id}/stream`;
          audioSource = {
            guideId: Number(q.audio_guide_id),
            variantId: res.variant.id,
            usedLang: res.usedLang || null,
            fellBack: !!res.fellBack,
          };
        }
      } catch (_err) { /* fall through to raw URL */ }
    }
    if (!resolvedAudioUrl) {
      resolvedAudioUrl = q.audio_url || null;
      // Stamp source-of-truth so the admin UI (and B2.3) can show what played.
      if (resolvedAudioUrl) audioSource = { guideId: null, variantId: null, usedLang: null, fellBack: false };
    }
  }

  // For admin AUDIO items with a linked guide, expose the available variant
  // languages so the live language switcher can render only chips for what
  // the guide actually has. Cheap one-row query, admin-only, audio-only.
  let audioAvailableLangs = null;
  if (isAudio && forAdmin && q.audio_guide_id) {
    try {
      audioAvailableLangs = await audioLibrary.listVariantLangs(q.audio_guide_id);
    } catch (_err) {
      audioAvailableLangs = [];
    }
  }

  return {
    session,
    lang: want,
    question: {
      id: q.id,
      orderIndex: q.order_index,
      kind: isAudio ? 'audio' : (isContest ? 'contest' : (q.kind || 'question')),
      prompt: promptResolved,
      // For contests and audio this is the description shown live (questions
      // reveal their explanation only after finishing).
      description: (isContest || isAudio) ? explanationResolved : null,
      audioUrl: isAudio ? resolvedAudioUrl : null,
      audioGuideId: isAudio && q.audio_guide_id ? Number(q.audio_guide_id) : null,
      audioSource: isAudio ? audioSource : null,
      audioAvailableLangs: isAudio ? (audioAvailableLangs || null) : null,
      points: q.points,
      status: session.current_question_status,
      deadline: session.current_question_deadline,
      remainingMs: session.remaining_ms != null ? session.remaining_ms : null,
      options: oRows.map((o) => {
        const text = textMap.has(o.id) ? textMap.get(o.id) : o.text;
        return forAdmin
          ? { id: o.id, orderIndex: o.order_index, text, isCorrect: o.is_correct }
          : { id: o.id, orderIndex: o.order_index, text };
      }),
    },
  };
}

/**
 * Live answer status for the CURRENT question — admin host view.
 *
 * For each team in the session: whether they've answered the current question
 * yet and (if so) when. Plus aggregate counts. Used by the admin live panel to
 * show "who are we still waiting for" during the timer.
 *
 * Does NOT reveal which option a team picked (that's only surfaced after the
 * question is finished, via getCurrentResults). Returns answered booleans only.
 */
async function getLiveStatus(sessionCode) {
  // Auto-close on timeout before reporting status, so the admin panel
  // transitions to round-results on the poll after the deadline.
  await expireIfDue(sessionCode);

  const session = await getByCode(sessionCode);
  if (!session) throw new HttpError(404, 'Session not found');

  const currentQuestionId = session.current_question_id;

  const { rows: teams } = await pool.query(
    `SELECT t.id, t.name, t.joined_at,
            a.submitted_at
       FROM teams t
       LEFT JOIN answers a
         ON a.team_id = t.id
        AND a.session_id = $1
        AND a.question_id = $2
      WHERE t.session_id = $1
      ORDER BY t.joined_at ASC`,
    [session.id, currentQuestionId || 0]
  );

  const teamStatus = teams.map((t) => ({
    teamId: t.id,
    teamName: t.name,
    answered: currentQuestionId ? t.submitted_at != null : false,
    answeredAt: currentQuestionId ? (t.submitted_at || null) : null,
  }));

  const total = teamStatus.length;
  const answeredCount = teamStatus.filter((t) => t.answered).length;

  return {
    session,
    currentQuestionId: currentQuestionId || null,
    currentQuestionStatus: session.current_question_status || null,
    deadline: session.current_question_deadline || null,
    counts: { total, answered: answeredCount, pending: total - answeredCount },
    teams: teamStatus,
  };
}

/**
 * Results of the most recently finished question in this session.
 * Returns the correct option's id+text (it's now public after the question
 * is over). Returns { question: null, results: [] } if no question has been
 * finished yet.
 */
async function getCurrentResults(sessionCode, { lang } = {}) {
  // Auto-close on timeout so results become available immediately after the
  // deadline, without waiting for a manual Finish.
  await expireIfDue(sessionCode);

  const session = await getByCode(sessionCode);
  if (!session) throw new HttpError(404, 'Session not found');
  const want = normalizeLang(lang);

  const { rows: latest } = await pool.query(
    `SELECT q.id, q.order_index, q.prompt, q.points, q.kind
       FROM round_results rr
       JOIN questions q ON q.id = rr.question_id
      WHERE rr.session_id = $1
      ORDER BY q.order_index DESC
      LIMIT 1`,
    [session.id]
  );
  if (!latest[0]) {
    return { session, question: null, correctOption: null, results: [] };
  }
  const question = latest[0];

  const { rows: correct } = await pool.query(
    `SELECT id, order_index, text FROM answer_options
      WHERE question_id = $1 AND is_correct = TRUE LIMIT 1`,
    [question.id]
  );

  // Per-team round result joined with the option each team actually selected
  // (from the answers table). selected_option_id is NULL for teams that didn't
  // answer.
  const { rows: results } = await pool.query(
    `SELECT rr.team_id, t.name AS team_name,
            rr.answered, rr.is_correct, rr.points_awarded,
            rr.rank, rr.cumulative_points,
            a.option_id AS selected_option_id,
            ao.order_index AS selected_order_index
       FROM round_results rr
       JOIN teams t ON t.id = rr.team_id
       LEFT JOIN answers a
         ON a.team_id = rr.team_id AND a.session_id = rr.session_id AND a.question_id = rr.question_id
       LEFT JOIN answer_options ao ON ao.id = a.option_id
      WHERE rr.session_id = $1 AND rr.question_id = $2
      ORDER BY rr.rank ASC, t.joined_at ASC`,
    [session.id, question.id]
  );

  const promptResolved = (await resolvePromptByLang(null, question.id, want)) ?? question.prompt;
  const explanationResolved = await resolveExplanationByLang(question.id, want);

  // Resolve the text of every option referenced (correct option + each team's
  // selected option) in one batch.
  const optionIdsToResolve = new Set();
  if (correct[0]) optionIdsToResolve.add(correct[0].id);
  for (const r of results) if (r.selected_option_id) optionIdsToResolve.add(r.selected_option_id);
  const textMap = await resolveOptionTexts([...optionIdsToResolve], want);

  let correctOption = null;
  if (correct[0]) {
    correctOption = {
      id: correct[0].id,
      orderIndex: correct[0].order_index,
      text: textMap.has(correct[0].id) ? textMap.get(correct[0].id) : correct[0].text,
    };
  }

  return {
    session,
    lang: want,
    question: {
      id: question.id,
      orderIndex: question.order_index,
      kind: question.kind || 'question',
      prompt: promptResolved,
      explanation: explanationResolved,
      points: question.points,
    },
    correctOption,
    results: results.map((r) => ({
      teamId: r.team_id,
      teamName: r.team_name,
      answered: r.answered,
      isCorrect: r.is_correct,
      pointsAwarded: r.points_awarded,
      rank: r.rank,
      cumulativePoints: r.cumulative_points,
      selectedOption: r.selected_option_id
        ? {
            id: r.selected_option_id,
            orderIndex: r.selected_order_index,
            text: textMap.has(r.selected_option_id) ? textMap.get(r.selected_option_id) : null,
          }
        : null,
    })),
  };
}

/** Returns the frozen final results, or null if not yet finalized. */
async function getFinalResults(sessionCode) {
  const session = await getByCode(sessionCode);
  if (!session) throw new HttpError(404, 'Session not found');

  const { rows } = await pool.query(
    `SELECT fr.team_id, t.name AS team_name, fr.total_points, fr.rank, fr.finalized_at
       FROM final_results fr
       JOIN teams t ON t.id = fr.team_id
      WHERE fr.session_id = $1
      ORDER BY fr.rank ASC, t.joined_at ASC`,
    [session.id]
  );

  if (rows.length === 0) {
    return { session, results: null };
  }

  return {
    session,
    results: rows.map((r) => ({
      teamId: r.team_id,
      teamName: r.team_name,
      totalPoints: r.total_points,
      rank: r.rank,
      finalizedAt: r.finalized_at,
    })),
  };
}

/**
 * List sessions with summary metadata for the history screen.
 * Newest first. Each row: code, quiz title (resolved), status, dates, team count.
 */
/**
 * Minimal quiz list for the session-creation picker.
 *
 * Distinct from `quizzes.listAll` because:
 *   - It must be reachable by any admin who can host a session (gated
 *     only on `challenges`, not on `challenges.manage_quizzes`). The
 *     management list returns full DTOs and gates on manage.
 *   - It returns ONLY what the picker needs (id, title, questionCount,
 *     languages) — no description, no admin metadata, no archived flag.
 *     Smaller surface, less information leakage to non-managers.
 *   - It hardcodes `is_archived = FALSE` — you can't host a session on
 *     an archived quiz, and a non-manager has no reason to see them.
 */
async function listQuizzesForHosting({ lang } = {}) {
  const want = normalizeLang(lang);
  const { rows } = await pool.query(
    `SELECT
       q.id,
       q.title       AS legacy_title,
       q.created_at,
       COALESCE(qc.cnt, 0)::int AS question_count
     FROM quizzes q
     LEFT JOIN (
       SELECT quiz_id, COUNT(*) AS cnt FROM questions GROUP BY quiz_id
     ) qc ON qc.quiz_id = q.id
     WHERE q.is_archived = FALSE
     ORDER BY q.created_at DESC, q.id DESC`
  );
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const { rows: trs } = await pool.query(
    `SELECT quiz_id, lang, title FROM quiz_translations WHERE quiz_id = ANY($1::int[])`,
    [ids]
  );
  const byQuiz = new Map();
  for (const t of trs) {
    if (!byQuiz.has(t.quiz_id)) byQuiz.set(t.quiz_id, {});
    byQuiz.get(t.quiz_id)[t.lang] = t.title;
  }

  return rows.map((r) => {
    const trMap = byQuiz.get(r.id) || {};
    const languages = Object.keys(trMap);
    let chosen = trMap[want];
    if (chosen == null) {
      for (const l of SUPPORTED_LANGS) { if (trMap[l] != null) { chosen = trMap[l]; break; } }
    }
    if (chosen == null) chosen = r.legacy_title || '(untitled)';
    return {
      id: r.id,
      title: chosen,
      questionCount: r.question_count,
      languages: languages.length ? languages : [],
    };
  });
}

async function listHistory({ lang } = {}) {
  const want = normalizeLang(lang);
  const { rows } = await pool.query(
    `SELECT
       s.id, s.session_code, s.status, s.created_at, s.started_at, s.ended_at,
       s.quiz_id,
       s.created_by,
       cre.username AS created_by_username,
       q.title AS legacy_title,
       COALESCE(tc.cnt, 0)::int AS team_count
     FROM quiz_sessions s
     LEFT JOIN quizzes q ON q.id = s.quiz_id
     LEFT JOIN admins cre ON cre.id = s.created_by
     LEFT JOIN (
       SELECT session_id, COUNT(*) AS cnt FROM teams GROUP BY session_id
     ) tc ON tc.session_id = s.id
     ORDER BY s.created_at DESC, s.id DESC`
  );
  if (rows.length === 0) return [];

  // Resolve quiz titles for the requested language in one batch.
  const quizIds = [...new Set(rows.map((r) => r.quiz_id).filter(Boolean))];
  const titleByQuiz = new Map();
  if (quizIds.length) {
    const { rows: trs } = await pool.query(
      `SELECT quiz_id, lang, title FROM quiz_translations WHERE quiz_id = ANY($1::int[])`,
      [quizIds]
    );
    const byQuiz = new Map();
    for (const t of trs) {
      if (!byQuiz.has(t.quiz_id)) byQuiz.set(t.quiz_id, {});
      byQuiz.get(t.quiz_id)[t.lang] = t.title;
    }
    for (const [qid, byLang] of byQuiz.entries()) {
      let chosen = byLang[want];
      if (chosen == null) for (const l of SUPPORTED_LANGS) { if (byLang[l] != null) { chosen = byLang[l]; break; } }
      if (chosen == null) { const ks = Object.keys(byLang); chosen = ks.length ? byLang[ks[0]] : null; }
      titleByQuiz.set(qid, chosen);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    sessionCode: r.session_code,
    quizId: r.quiz_id,
    quizTitle: titleByQuiz.get(r.quiz_id) || r.legacy_title || '(deleted quiz)',
    status: r.status,
    teamCount: r.team_count,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    createdBy: r.created_by == null ? null : r.created_by,
    createdByUsername: r.created_by_username || null,
  }));
}

/**
 * Read-only summary of a single session: metadata + teams + final standings
 * if finalized (else the latest round standings). Used by the history detail.
 */
async function getSummary(sessionCode, { lang } = {}) {
  const session = await getByCode(sessionCode);
  if (!session) throw new HttpError(404, 'Session not found');

  const teams = await listTeams(session.id);

  // Prefer final results; fall back to the latest cumulative standings.
  const { rows: finals } = await pool.query(
    `SELECT fr.team_id, t.name AS team_name, fr.total_points, fr.rank
       FROM final_results fr JOIN teams t ON t.id = fr.team_id
      WHERE fr.session_id = $1 ORDER BY fr.rank ASC, t.joined_at ASC`,
    [session.id]
  );

  let standings = finals.map((r) => ({
    teamId: r.team_id, teamName: r.team_name, points: r.total_points, rank: r.rank,
  }));
  let standingsType = 'final';

  if (standings.length === 0) {
    const { rows: latest } = await pool.query(
      `SELECT rr.team_id, t.name AS team_name, rr.cumulative_points, rr.rank
         FROM round_results rr JOIN teams t ON t.id = rr.team_id
        WHERE rr.session_id = $1
          AND rr.question_id = (
            SELECT question_id FROM round_results WHERE session_id = $1
            ORDER BY id DESC LIMIT 1
          )
        ORDER BY rr.rank ASC, t.joined_at ASC`,
      [session.id]
    );
    standings = latest.map((r) => ({
      teamId: r.team_id, teamName: r.team_name, points: r.cumulative_points, rank: r.rank,
    }));
    standingsType = standings.length ? 'partial' : 'none';
  }

  // Question count answered (number of finished rounds).
  const { rows: roundRows } = await pool.query(
    `SELECT COUNT(DISTINCT question_id)::int AS c FROM round_results WHERE session_id = $1`,
    [session.id]
  );

  return {
    session,
    teams: teams.map((t) => ({ id: t.id, name: t.name, joinedAt: t.joined_at })),
    roundsPlayed: roundRows[0].c,
    standingsType,
    standings,
  };
}

/**
 * Delete a session and all its history (teams, answers, round_results,
 * final_results) via ON DELETE CASCADE. Does NOT touch the quiz.
 */
async function remove(sessionCode) {
  const { rows } = await pool.query(
    `DELETE FROM quiz_sessions WHERE session_code = $1 RETURNING id`,
    [sessionCode]
  );
  if (!rows[0]) throw new HttpError(404, 'Session not found');
  return { deleted: true, id: rows[0].id };
}

/**
 * Ownership check for session-control actions.
 *
 * Returns true if the admin may control this session, false otherwise.
 * Rules (ordered, first-match wins):
 *   - super_admin → always true.
 *   - sessionRow.created_by === adminId → true (the creator hosts).
 *   - sessionRow.created_by === NULL → true (legacy/pre-ownership row;
 *       anyone with the route's permission gates may control it. This
 *       preserves access to sessions created before ownership shipped).
 *   - otherwise → false.
 *
 * Pass the SAME sessionRow the handler already loaded (no extra query).
 */
function canControlSession(adminId, role, sessionRow) {
  if (role === 'super_admin') return true;
  if (!sessionRow) return false;
  if (sessionRow.created_by == null) return true; // legacy / no-owner
  return Number(sessionRow.created_by) === Number(adminId);
}

function assertCanControlSession(adminId, role, sessionRow) {
  if (!canControlSession(adminId, role, sessionRow)) {
    throw new HttpError(403, 'Forbidden — only the session owner or a super_admin can control this session');
  }
}

module.exports = {
  create,
  getByCode,
  listTeams,
  startSession,
  startQuestion,
  pauseQuestion,
  resumeQuestion,
  awardContestPoints,
  finishQuestion,
  closeSession,
  getCurrentQuestion,
  getLiveStatus,
  getCurrentResults,
  getFinalResults,
  listHistory,
  listQuizzesForHosting,
  getSummary,
  remove,
  canControlSession,
  assertCanControlSession,
};
