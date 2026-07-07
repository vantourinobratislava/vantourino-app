'use strict';

const pool = require('../db/pool');
const HttpError = require('../utils/httpError');
const teamToken = require('../utils/teamToken');
const { isTerminal } = require('../utils/statuses');

// Token entropy is 192 bits (crypto.randomBytes(24)); collisions are
// effectively impossible. A few retries cover any hypothetical clash.
const MAX_TOKEN_ATTEMPTS = 4;

async function join({ sessionCode, teamName }) {
  if (!teamName || typeof teamName !== 'string') {
    throw new HttpError(400, 'teamName is required');
  }
  const name = teamName.trim();
  if (name.length < 2 || name.length > 100) {
    throw new HttpError(400, 'teamName must be 2–100 characters');
  }

  const { rows: sessionRows } = await pool.query(
    'SELECT id, status FROM quiz_sessions WHERE session_code = $1 LIMIT 1',
    [sessionCode]
  );
  const session = sessionRows[0];
  if (!session) {
    throw new HttpError(404, 'Session not found');
  }
  // Block join once the session is over (finished, closed, or legacy v2
  // completed/cancelled). Mid-game joins (active, round_results) are allowed.
  if (isTerminal(session.status)) {
    throw new HttpError(409, `Session is ${session.status}; no new teams can join`);
  }

  for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt++) {
    const token = teamToken.generate();
    try {
      const { rows } = await pool.query(
        `INSERT INTO teams (session_id, name, token)
         VALUES ($1, $2, $3)
         RETURNING id, session_id, name, token, joined_at`,
        [session.id, name, token]
      );
      return rows[0];
    } catch (err) {
      if (err.code === '23505') {
        // Distinguish duplicate name vs duplicate token via constraint name
        if (err.constraint === 'uq_teams_token') continue;
        if (err.constraint === 'uq_teams_session_name') {
          throw new HttpError(409, 'Team name already taken in this session');
        }
        throw new HttpError(409, 'Conflict creating team');
      }
      throw err;
    }
  }
  throw new HttpError(500, 'Could not allocate a unique team token');
}

/** Look up a team by (sessionCode, token). Returns null if unknown. */
async function findByToken(sessionCode, token) {
  if (!token || typeof token !== 'string') return null;
  const { rows } = await pool.query(
    `SELECT t.id, t.session_id, t.name, t.joined_at
       FROM teams t
       JOIN quiz_sessions qs ON qs.id = t.session_id
      WHERE qs.session_code = $1 AND t.token = $2
      LIMIT 1`,
    [sessionCode, token]
  );
  return rows[0] || null;
}

module.exports = { join, findByToken };
