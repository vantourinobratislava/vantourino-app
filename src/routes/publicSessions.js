'use strict';

const express = require('express');
const teams = require('../services/teams');
const answers = require('../services/answers');
const quizSessions = require('../services/quizSessions');
const HttpError = require('../utils/httpError');

const router = express.Router();

function extractBearer(req) {
  const header = req.get('Authorization');
  if (header && typeof header === 'string') {
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  // Fallback to body for clients that can't easily set headers.
  if (req.body && typeof req.body.teamToken === 'string') {
    return req.body.teamToken.trim();
  }
  return null;
}

// POST /api/session/:sessionCode/join
// Body: { teamName }
// Returns: { team: { id, name, joinedAt }, sessionCode, token }
router.post('/:sessionCode/join', async (req, res, next) => {
  try {
    const { teamName } = req.body || {};
    const team = await teams.join({
      sessionCode: req.params.sessionCode,
      teamName,
    });
    res.status(201).json({
      team: {
        id: team.id,
        name: team.name,
        joinedAt: team.joined_at,
      },
      sessionCode: req.params.sessionCode,
      token: team.token,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/session/:sessionCode/current-question
// Team-facing view: hides is_correct on options; returns null unless live.
router.get('/:sessionCode/current-question', async (req, res, next) => {
  try {
    const out = await quizSessions.getCurrentQuestion(req.params.sessionCode, { forAdmin: false, lang: req.query.lang });
    res.json({
      sessionCode: out.session.session_code,
      sessionStatus: out.session.status,
      question: out.question,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/session/:sessionCode/questions/:questionId/answer
// Header: Authorization: Bearer <team token>   (or body.teamToken)
// Body:   { optionId }
router.post('/:sessionCode/questions/:questionId/answer', async (req, res, next) => {
  try {
    const token = extractBearer(req);
    const { optionId } = req.body || {};
    const out = await answers.submit({
      sessionCode: req.params.sessionCode,
      questionId: req.params.questionId,
      optionId,
      teamToken: token,
    });
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
});

// GET /api/session/:sessionCode/results/current
router.get('/:sessionCode/results/current', async (req, res, next) => {
  try {
    const out = await quizSessions.getCurrentResults(req.params.sessionCode, { lang: req.query.lang });
    res.json({
      sessionCode: out.session.session_code,
      sessionStatus: out.session.status,
      question: out.question,
      correctOption: out.correctOption,
      results: out.results,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/session/:sessionCode/results/final
router.get('/:sessionCode/results/final', async (req, res, next) => {
  try {
    const out = await quizSessions.getFinalResults(req.params.sessionCode);
    if (out.results === null) {
      throw new HttpError(409, 'Final results are not available yet (session not finished or closed)');
    }
    res.json({
      sessionCode: out.session.session_code,
      sessionStatus: out.session.status,
      results: out.results,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
