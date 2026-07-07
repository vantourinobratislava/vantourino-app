'use strict';

const pool = require('../db/pool');
const HttpError = require('../utils/httpError');
const { QuestionStatus, isTerminal } = require('../utils/statuses');

/**
 * Submit a team's answer for the current question.
 *
 * Single source of truth: quiz_sessions.current_question_id is "which question
 * is current"; quiz_sessions.current_question_status is "what state it's in."
 * No other table tracks this, so there's no possibility of disagreement.
 *
 * Atomicity: the INSERT runs under a WHERE EXISTS that re-checks the session's
 * state at the moment of insert. If admin finishes the question between our
 * read and our write, the insert returns zero rows and we diagnose precisely.
 *
 * Duplicate prevention: at the DB level via UNIQUE(session_id, question_id,
 * team_id). Application logic isn't relied on for this guarantee.
 */
async function submit({ sessionCode, questionId, optionId, teamToken }) {
  const qid = Number(questionId);
  if (!Number.isInteger(qid) || qid < 1) {
    throw new HttpError(400, 'questionId must be a positive integer');
  }
  const oid = Number(optionId);
  if (!Number.isInteger(oid) || oid < 1) {
    throw new HttpError(400, 'optionId must be a positive integer');
  }
  if (!teamToken || typeof teamToken !== 'string') {
    throw new HttpError(401, 'Team token is required (Authorization: Bearer <token>)');
  }

  // 1. Resolve team via (sessionCode, token). Establishes "team is in session".
  //    This is the only place answer-time authentication happens.
  const { rows: teamRows } = await pool.query(
    `SELECT t.id AS team_id, t.session_id
       FROM teams t
       JOIN quiz_sessions qs ON qs.id = t.session_id
      WHERE qs.session_code = $1 AND t.token = $2
      LIMIT 1`,
    [sessionCode, teamToken]
  );
  const team = teamRows[0];
  if (!team) {
    throw new HttpError(401, 'Invalid team token for this session');
  }

  // 2. Validate option belongs to the named question.
  const { rows: optRows } = await pool.query(
    `SELECT id FROM answer_options WHERE id = $1 AND question_id = $2 LIMIT 1`,
    [oid, qid]
  );
  if (!optRows[0]) {
    throw new HttpError(400, 'Option does not belong to this question');
  }

  // 3. Conditional insert: only if the question is currently live for this
  //    session AND its deadline has not passed. The deadline check makes late
  //    answers impossible at the DB level, even in the brief window before a
  //    poll triggers auto-finish.
  //    UNIQUE(session_id, question_id, team_id) makes "answer twice" a 23505.
  try {
    const { rows } = await pool.query(
      `INSERT INTO answers (session_id, question_id, team_id, option_id)
       SELECT $1::int, $2::int, $3::int, $4::int
       WHERE EXISTS (
         SELECT 1 FROM quiz_sessions
          WHERE id = $1::int
            AND current_question_id = $2::int
            AND current_question_status = $5
            AND current_question_deadline IS NOT NULL
            AND current_question_deadline > NOW()
       )
       RETURNING id, submitted_at`,
      [team.session_id, qid, team.team_id, oid, QuestionStatus.LIVE]
    );

    if (rows.length === 0) {
      // Not accepted — diagnose precisely so the client knows what to do.
      const { rows: sRows } = await pool.query(
        `SELECT status, current_question_id, current_question_status,
                (current_question_deadline IS NOT NULL
                 AND current_question_deadline <= NOW()) AS expired
           FROM quiz_sessions WHERE id = $1`,
        [team.session_id]
      );
      const s = sRows[0];
      if (!s) throw new HttpError(404, 'Session not found');
      if (isTerminal(s.status)) {
        throw new HttpError(409, `Session is ${s.status}; no answers accepted`);
      }
      if (s.current_question_id !== qid) {
        throw new HttpError(409, 'This is not the current question');
      }
      if (s.current_question_status === QuestionStatus.LIVE && s.expired) {
        throw new HttpError(409, 'Time is up; this question is closed');
      }
      throw new HttpError(
        409,
        `Question is ${s.current_question_status || 'not active'}; no answers accepted`
      );
    }

    return {
      accepted: true,
      answerId: rows[0].id,
      submittedAt: rows[0].submitted_at,
    };
  } catch (err) {
    if (err.code === '23505') {
      throw new HttpError(409, 'Team has already answered this question');
    }
    throw err;
  }
}

module.exports = { submit };
