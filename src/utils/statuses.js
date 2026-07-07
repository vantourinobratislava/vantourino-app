'use strict';

/**
 * Centralized status values for the quiz state machines.
 *
 * Importing constants from here (instead of repeating string literals across
 * services and routes) keeps the state machine in one place and makes typos
 * trip immediately at edit time.
 */

const SessionStatus = Object.freeze({
  PENDING:       'pending',
  ACTIVE:        'active',
  ROUND_RESULTS: 'round_results',
  FINISHED:      'finished',
  CLOSED:        'closed',
});

const QuestionStatus = Object.freeze({
  NOT_STARTED: 'not_started',
  LIVE:        'live',
  PAUSED:      'paused',
  CLOSED:      'closed',
});

// Legacy session statuses from v0.2.0. Preserved in the DB CHECK constraint
// so old rows don't fail, and recognized here as "session is over" — but the
// v3 lifecycle never writes them.
const LegacySessionStatus = Object.freeze({
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

// "Session is over" — no new joins, no answers, no runtime progression.
const TERMINAL_SESSION_STATUSES = new Set([
  SessionStatus.FINISHED,
  SessionStatus.CLOSED,
  LegacySessionStatus.COMPLETED,
  LegacySessionStatus.CANCELLED,
]);

// Statuses during which startQuestion is allowed.
const CAN_START_QUESTION_FROM = new Set([
  SessionStatus.ACTIVE,
  SessionStatus.ROUND_RESULTS,
]);

function isTerminal(status) {
  return TERMINAL_SESSION_STATUSES.has(status);
}

module.exports = {
  SessionStatus,
  QuestionStatus,
  LegacySessionStatus,
  TERMINAL_SESSION_STATUSES,
  CAN_START_QUESTION_FROM,
  isTerminal,
};
