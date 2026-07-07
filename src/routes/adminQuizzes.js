'use strict';

const express = require('express');
const multer = require('multer');
const requireAdmin = require('../middleware/requireAdmin');
const { requireRole, requirePermission } = requireAdmin;
const quizzes = require('../services/quizzes');
const questions = require('../services/questions');
const quizImport = require('../services/quizImport');
const HttpError = require('../utils/httpError');

const router = express.Router();

// In-memory upload, capped at 2 MB. We parse the buffer server-side; the file
// is never written to disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});

// POST /api/admin/quizzes/import/preview   (multipart/form-data, field "file")
// Parses + validates the .xlsx, persists nothing. Returns preview + errors +
// a normalized payload to pass back to /import/commit.
router.post('/import/preview', requireAdmin, requirePermission('challenges'), requirePermission('challenges.manage_quizzes'), requireRole('manager'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) throw new HttpError(400, 'No file uploaded (field name must be "file")');
    const result = quizImport.preview(req.file.buffer);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/quizzes/import/commit   (JSON: { payload })
// Re-validates and writes the quiz in one transaction.
router.post('/import/commit', requireAdmin, requirePermission('challenges'), requirePermission('challenges.manage_quizzes'), requirePermission('challenges.create_quiz'), requireRole('manager'), async (req, res, next) => {
  try {
    const payload = req.body && req.body.payload;
    const result = await quizImport.commit(payload, { adminId: req.session.adminId });
    res.status(201).json(result); // { id, title, createdAt, questionCount }
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/quizzes?lang=en&includeArchived=1
// Lists quizzes for the create-session dropdown (archived excluded by default).
router.get('/', requireAdmin, requirePermission('challenges'), requirePermission('challenges.manage_quizzes'), async (req, res, next) => {
  try {
    const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
    const list = await quizzes.listAll({ lang: req.query.lang, includeArchived });
    res.json({ quizzes: list });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/quizzes/:quizId
// Full multilingual quiz for the editor (all languages, all questions/options,
// correctness included). Admin-only.
router.get('/:quizId', requireAdmin, requirePermission('challenges'), requirePermission('challenges.manage_quizzes'), async (req, res, next) => {
  try {
    const quizId = Number(req.params.quizId);
    if (!Number.isInteger(quizId) || quizId < 1) {
      throw new HttpError(400, 'quizId must be a positive integer');
    }
    const full = await quizzes.getFull(quizId);
    if (!full) throw new HttpError(404, 'Quiz not found');
    // Surface whether the quiz is editable structurally (no session refs).
    const sessionRefs = await quizzes.countSessionRefs(quizId);
    res.json({ quiz: full, sessionRefs, usedInSessions: sessionRefs > 0 });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/quizzes/:quizId
// Body: { translations: { en: { title, description? }, sk: {...}, de: {...} } }
// Upserts the provided languages; others left untouched.
router.patch('/:quizId', requireAdmin, requirePermission('challenges'), requirePermission('challenges.manage_quizzes'), requireRole('manager'), async (req, res, next) => {
  try {
    const quizId = Number(req.params.quizId);
    if (!Number.isInteger(quizId) || quizId < 1) {
      throw new HttpError(400, 'quizId must be a positive integer');
    }
    const { translations } = req.body || {};
    const updated = await quizzes.updateMetadata(quizId, { translations });
    res.json({ quiz: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/quizzes/:quizId
// Hard-deletes if the quiz has no session references; otherwise archives it.
router.delete('/:quizId', requireAdmin, requirePermission('challenges'), requirePermission('challenges.manage_quizzes'), requireRole('manager'), async (req, res, next) => {
  try {
    const quizId = Number(req.params.quizId);
    if (!Number.isInteger(quizId) || quizId < 1) {
      throw new HttpError(400, 'quizId must be a positive integer');
    }
    const result = await quizzes.remove(quizId);
    res.json(result); // { action: 'deleted' | 'archived', sessionRefs }
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/quizzes/:quizId/duplicate
// Deep-copies the quiz into a new, independent quiz.
router.post('/:quizId/duplicate', requireAdmin, requirePermission('challenges'), requirePermission('challenges.manage_quizzes'), requirePermission('challenges.create_quiz'), requireRole('manager'), async (req, res, next) => {
  try {
    const quizId = Number(req.params.quizId);
    if (!Number.isInteger(quizId) || quizId < 1) {
      throw new HttpError(400, 'quizId must be a positive integer');
    }
    const result = await quizzes.duplicate(quizId, { adminId: req.session.adminId });
    res.status(201).json(result); // { id, title, createdAt }
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/quizzes
// Body (legacy):       { title, description? }
// Body (multilingual): { translations: { en: { title, description? }, sk: {...}, de: {...} } }
router.post('/', requireAdmin, requirePermission('challenges'), requirePermission('challenges.manage_quizzes'), requirePermission('challenges.create_quiz'), requireRole('manager'), async (req, res, next) => {
  try {
    const { title, description, translations } = req.body || {};
    const quiz = await quizzes.create({
      title,
      description,
      translations,
      adminId: req.session.adminId,
    });
    res.status(201).json({
      id: quiz.id,
      title: quiz.title,
      description: quiz.description,
      languages: quiz.languages,
      createdAt: quiz.created_at,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/quizzes/:quizId/questions/order
// Body: { orderedIds: [questionId, ...] } — a permutation of the quiz's questions.
// MUST be declared before /:quizId/questions/:questionId so "order" isn't
// captured as a questionId.
router.patch('/:quizId/questions/order', requireAdmin, requirePermission('challenges'), requirePermission('challenges.manage_quizzes'), requireRole('manager'), async (req, res, next) => {
  try {
    const quizId = Number(req.params.quizId);
    if (!Number.isInteger(quizId) || quizId < 1) {
      throw new HttpError(400, 'quizId must be a positive integer');
    }
    const { orderedIds } = req.body || {};
    await questions.reorder(quizId, orderedIds);
    const full = await quizzes.getFull(quizId);
    res.json({ quiz: full });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/quizzes/:quizId/questions/:questionId
// Body: { points?, correctOptionId?, prompts?: {en,sk,de},
//         options?: [{ id, texts: {en,sk,de} }] }
// Edits text/points/correct option without changing option structure.
router.patch('/:quizId/questions/:questionId', requireAdmin, requirePermission('challenges'), requirePermission('challenges.manage_quizzes'), requireRole('manager'), async (req, res, next) => {
  try {
    const quizId = Number(req.params.quizId);
    if (!Number.isInteger(quizId) || quizId < 1) {
      throw new HttpError(400, 'quizId must be a positive integer');
    }
    await questions.updateQuestion(quizId, req.params.questionId, req.body || {});
    // Return the refreshed full quiz so the editor can re-sync.
    const full = await quizzes.getFull(quizId);
    res.json({ quiz: full });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/quizzes/:quizId/questions/:questionId
// Removes a single item (question or contest) and renumbers the rest so
// order_index stays contiguous. Returns the refreshed full quiz.
router.delete('/:quizId/questions/:questionId', requireAdmin, requirePermission('challenges'), requirePermission('challenges.manage_quizzes'), requireRole('manager'), async (req, res, next) => {
  try {
    const quizId = Number(req.params.quizId);
    if (!Number.isInteger(quizId) || quizId < 1) {
      throw new HttpError(400, 'quizId must be a positive integer');
    }
    await questions.deleteQuestion(quizId, req.params.questionId);
    const full = await quizzes.getFull(quizId);
    res.json({ quiz: full });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/quizzes/:quizId/questions
// Body (legacy):       { prompt, points?, orderIndex?, options: [{ text, isCorrect }] }
// Body (multilingual): { points?, orderIndex?, correctIndex,
//                        translations: { en: { prompt, options:[...] }, sk: {...} } }
router.post('/:quizId/questions', requireAdmin, requirePermission('challenges'), requirePermission('challenges.manage_quizzes'), requireRole('manager'), async (req, res, next) => {
  try {
    const quizId = Number(req.params.quizId);
    if (!Number.isInteger(quizId) || quizId < 1) {
      throw new HttpError(400, 'quizId must be a positive integer');
    }
    const result = await questions.addQuestion(quizId, req.body || {});
    res.status(201).json({
      question: {
        id: result.question.id,
        quizId: result.question.quiz_id,
        orderIndex: result.question.order_index,
        prompt: result.question.prompt,
        points: result.question.points,
        createdAt: result.question.created_at,
      },
      options: result.options.map((o) => ({
        id: o.id,
        orderIndex: o.order_index,
        text: o.text,
        isCorrect: o.is_correct,
      })),
      languages: result.languages,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
