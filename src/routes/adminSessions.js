'use strict';

const express = require('express');
const requireAdmin = require('../middleware/requireAdmin');
const { requireRole, requirePermission } = requireAdmin;
const quizSessions = require('../services/quizSessions');
const quizzes = require('../services/quizzes');
const HttpError = require('../utils/httpError');

const router = express.Router();

/**
 * Ownership middleware for session-control actions.
 *
 * Loads the session by :sessionCode and asserts that the signed-in admin
 * may control it (super_admin always; otherwise the creator; legacy rows
 * with NULL created_by are open to any caller who passed the role/perm
 * gates). Attaches `req.sessionRow` so the downstream handler can reuse
 * it without a second query.
 *
 * 404 if the code doesn't exist; 403 if the admin can't control it.
 */
async function requireSessionOwnership(req, res, next) {
  try {
    const row = await quizSessions.getByCode(req.params.sessionCode);
    if (!row) throw new HttpError(404, 'Session not found');
    quizSessions.assertCanControlSession(req.admin.id, req.admin.role, row);
    req.sessionRow = row;
    return next();
  } catch (err) {
    return next(err);
  }
}

// Common shape used in several responses
function sessionView(s) {
  return {
    id: s.id,
    sessionCode: s.session_code,
    quizId: s.quiz_id,
    status: s.status,
    answerTimeSeconds: s.answer_time_seconds,
    createdAt: s.created_at,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    currentQuestionId: s.current_question_id,
    currentQuestionStatus: s.current_question_status,
    currentQuestionDeadline: s.current_question_deadline,
    remainingMs: s.remaining_ms != null ? s.remaining_ms : null,
    // Phase 1C ownership — present so the frontend can render
    // "owned by me / view-only" without a second round-trip.
    createdBy: s.created_by == null ? null : s.created_by,
    createdByUsername: s.created_by_username || null,
  };
}

// GET /api/admin/quiz-sessions  → session history list (newest first).
// Distinct from POST / (create) and from GET /:sessionCode (detail).
router.get('/', requireAdmin, requirePermission('challenges'), requirePermission('challenges.session_history'), async (req, res, next) => {
  try {
    const sessions = await quizSessions.listHistory({ lang: req.query.lang });
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/quiz-sessions/quizzes-for-hosting
//
// Lighter-weight quiz list used by the "Start a session" picker. Gated on
// `challenges` only — operators with `manage_quizzes = false` still need
// to pick a quiz to host. Returns a minimal DTO (id/title/questionCount/
// languages) and excludes archived quizzes. The management list at
// /api/admin/quizzes (gated on `manage_quizzes`) is unchanged and still
// returns the full DTO for authoring.
router.get('/quizzes-for-hosting', requireAdmin, requirePermission('challenges'), async (req, res, next) => {
  try {
    const quizzes = await quizSessions.listQuizzesForHosting({ lang: req.query.lang });
    res.json({ quizzes });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/quiz-sessions
//   Body: { quizId } OR { title, description?, answerTimeSeconds? }
// POST /api/admin/quiz-sessions
//   Body: { quizId } OR { title, description?, answerTimeSeconds? }
//
// Hosting a session is OPERATIONAL — gated on `challenges` and role
// `operator`. Authoring a NEW quiz inline is still gated by
// `challenges.create_quiz` (enforced below at the service layer for
// the v2-compat title-only path).
router.post('/', requireAdmin, requirePermission('challenges'), requireRole('operator'), async (req, res, next) => {
  try {
    const { quizId, title, description, answerTimeSeconds } = req.body || {};
    // Inline quiz creation (v2 compat) still requires create_quiz.
    if (!quizId && title && !req.admin.effectivePermissions['challenges.create_quiz']) {
      throw new HttpError(403, 'Forbidden (permission: challenges.create_quiz)');
    }
    const result = await quizSessions.create({
      quizId,
      title,
      description,
      answerTimeSeconds,
      adminId: req.session.adminId,
    });
    res.status(201).json({
      session: sessionView(result.session),
      quiz: {
        id: result.quiz.id,
        title: result.quiz.title,
        description: result.quiz.description,
        createdAt: result.quiz.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/quiz-sessions/:sessionCode?lang=en
router.get('/:sessionCode', requireAdmin, requirePermission('challenges'), async (req, res, next) => {
  try {
    const session = await quizSessions.getByCode(req.params.sessionCode);
    if (!session) throw new HttpError(404, 'Session not found');

    const lang = req.query.lang;
    const [teams, qList, quizTr] = await Promise.all([
      quizSessions.listTeams(session.id),
      quizzes.listQuestions(session.quiz_id, { includeCorrect: false, lang }),
      quizzes.getTranslations(session.quiz_id),
    ]);

    // Resolve quiz title/description for the requested language, fall back
    // to the legacy column held on the session row.
    const want = (lang || 'en').toLowerCase();
    const chosen = quizTr[want]
      || quizTr.en || quizTr.sk || quizTr.de
      || { title: session.quiz_title, description: session.quiz_description };

    res.json({
      session: sessionView(session),
      quiz: {
        id: session.quiz_id,
        title: chosen.title,
        description: chosen.description,
        languages: Object.keys(quizTr),
        questions: qList.map((q) => ({
          id: q.id,
          orderIndex: q.order_index,
          prompt: q.prompt,
          points: q.points,
          kind: q.kind || 'question',
          // Full options for the live host view. Text is already resolved to
          // the requested language by listQuestions(); is_correct is omitted
          // (includeCorrect: false) so the correct answer is NOT exposed during
          // the live question. optionCount kept for backward compatibility.
          optionCount: q.options.length,
          options: q.options.map((o) => ({
            id: o.id,
            orderIndex: o.order_index,
            text: o.text,
          })),
        })),
      },
      teams: teams.map((t) => ({ id: t.id, name: t.name, joinedAt: t.joined_at })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/quiz-sessions/:sessionCode/start
router.post('/:sessionCode/start', requireAdmin, requirePermission('challenges'), requireRole('operator'), requireSessionOwnership, async (req, res, next) => {
  try {
    const session = await quizSessions.startSession(req.params.sessionCode);
    res.json({ session: sessionView(session) });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/quiz-sessions/:sessionCode/questions/:questionId/start
router.post('/:sessionCode/questions/:questionId/start', requireAdmin, requirePermission('challenges'), requireRole('operator'), requireSessionOwnership, async (req, res, next) => {
  try {
    const out = await quizSessions.startQuestion(req.params.sessionCode, req.params.questionId);
    res.json({
      questionId: out.questionId,
      status: 'live',
      deadline: out.deadline,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/quiz-sessions/:sessionCode/questions/:questionId/finish
router.post('/:sessionCode/questions/:questionId/finish', requireAdmin, requirePermission('challenges'), requireRole('operator'), requireSessionOwnership, async (req, res, next) => {
  try {
    const out = await quizSessions.finishQuestion(req.params.sessionCode, req.params.questionId);
    const session = await quizSessions.getByCode(req.params.sessionCode);
    res.json({
      questionId: Number(req.params.questionId),
      finished: true,
      isLastQuestion: out.isLast,
      audio: !!out.audio,
      sessionStatus: session ? session.status : null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/quiz-sessions/:sessionCode/questions/:questionId/pause
router.post('/:sessionCode/questions/:questionId/pause', requireAdmin, requirePermission('challenges'), requireRole('operator'), requireSessionOwnership, async (req, res, next) => {
  try {
    const out = await quizSessions.pauseQuestion(req.params.sessionCode, req.params.questionId);
    res.json({ questionId: out.questionId, status: out.status, remainingMs: out.remainingMs });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/quiz-sessions/:sessionCode/questions/:questionId/resume
router.post('/:sessionCode/questions/:questionId/resume', requireAdmin, requirePermission('challenges'), requireRole('operator'), requireSessionOwnership, async (req, res, next) => {
  try {
    const out = await quizSessions.resumeQuestion(req.params.sessionCode, req.params.questionId);
    res.json({ questionId: out.questionId, status: out.status, deadline: out.deadline });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/quiz-sessions/:sessionCode/questions/:questionId/award
// Body: { awards: [{ teamId, points }] } — manual contest scoring.
router.post('/:sessionCode/questions/:questionId/award', requireAdmin, requirePermission('challenges'), requireRole('operator'), requireSessionOwnership, async (req, res, next) => {
  try {
    const { awards } = req.body || {};
    const out = await quizSessions.awardContestPoints(req.params.sessionCode, req.params.questionId, awards);
    res.json(out); // { ok, count, maxPoints }
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/quiz-sessions/:sessionCode/current-question
router.get('/:sessionCode/current-question', requireAdmin, requirePermission('challenges'), async (req, res, next) => {
  try {
    const out = await quizSessions.getCurrentQuestion(req.params.sessionCode, {
      forAdmin: true,
      lang: req.query.lang,
      audioLang: req.query.audioLang,
    });
    res.json({
      sessionCode: out.session.session_code,
      sessionStatus: out.session.status,
      question: out.question,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/quiz-sessions/:sessionCode/live-status
// Per-team answered/pending status for the CURRENT question (host view).
router.get('/:sessionCode/live-status', requireAdmin, requirePermission('challenges'), async (req, res, next) => {
  try {
    const out = await quizSessions.getLiveStatus(req.params.sessionCode);
    res.json({
      sessionCode: out.session.session_code,
      sessionStatus: out.session.status,
      currentQuestionId: out.currentQuestionId,
      currentQuestionStatus: out.currentQuestionStatus,
      deadline: out.deadline,
      counts: out.counts,
      teams: out.teams,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/quiz-sessions/:sessionCode/results/current
router.get('/:sessionCode/results/current', requireAdmin, requirePermission('challenges'), async (req, res, next) => {
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

// GET /api/admin/quiz-sessions/:sessionCode/results/final
router.get('/:sessionCode/results/final', requireAdmin, requirePermission('challenges'), async (req, res, next) => {
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

// POST /api/admin/quiz-sessions/:sessionCode/close
router.post('/:sessionCode/close', requireAdmin, requirePermission('challenges'), requireRole('operator'), requireSessionOwnership, async (req, res, next) => {
  try {
    await quizSessions.closeSession(req.params.sessionCode);
    const session = await quizSessions.getByCode(req.params.sessionCode);
    res.json({ session: sessionView(session) });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/quiz-sessions/:sessionCode/summary  → read-only history detail
router.get('/:sessionCode/summary', requireAdmin, requirePermission('challenges'), requirePermission('challenges.session_history'), async (req, res, next) => {
  try {
    const out = await quizSessions.getSummary(req.params.sessionCode, { lang: req.query.lang });
    res.json({
      session: sessionView(out.session),
      teams: out.teams,
      roundsPlayed: out.roundsPlayed,
      standingsType: out.standingsType,
      standings: out.standings,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/quiz-sessions/:sessionCode  → delete session + its history
// (cascades teams/answers/round_results/final_results; does NOT touch the quiz)
router.delete('/:sessionCode', requireAdmin, requirePermission('challenges'), requirePermission('challenges.manage_quizzes'), requireRole('manager'), requireSessionOwnership, async (req, res, next) => {
  try {
    const result = await quizSessions.remove(req.params.sessionCode);
    res.json(result); // { deleted: true, id }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
