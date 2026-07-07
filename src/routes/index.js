'use strict';

const express = require('express');
const adminAuth = require('./adminAuth');
const adminUsers = require('./adminUsers');
const adminQuizzes = require('./adminQuizzes');
const adminSessions = require('./adminSessions');
const publicSessions = require('./publicSessions');
const { publicRouter: modulesPublic, adminRouter: modulesAdmin } = require('./modules');
const { adminRouter: audioAdmin, publicRouter: audioPublic } = require('./audioLibrary');
const { adminRouter: ridesAdmin } = require('./rides');

const router = express.Router();

// Admin: /api/admin/login, /api/admin/logout, /api/admin/me
router.use('/admin', adminAuth);

// Admin: /api/admin/users (super_admin only) — Phase 1C-B Users management
router.use('/admin/users', adminUsers);

// Admin: /api/admin/quizzes, /api/admin/quizzes/:quizId/questions
router.use('/admin/quizzes', adminQuizzes);

// Admin: /api/admin/quiz-sessions[/...]
router.use('/admin/quiz-sessions', adminSessions);

// Admin: /api/admin/modules/rules, /api/admin/modules/sirups
router.use('/admin/modules', modulesAdmin);

// Admin: /api/admin/audio (audioguides library: upload/list/rename/delete)
router.use('/admin/audio', audioAdmin);

// Admin-only: /api/admin/rides (Rides Phase 1)
router.use('/admin/rides', ridesAdmin);

// Public: /api/session/:sessionCode/...
router.use('/session', publicSessions);

// Public: /api/modules/rules, /api/modules/sirups
router.use('/modules', modulesPublic);

// Public: /api/audio/:id/stream  (Range-enabled audio streaming)
router.use('/audio', audioPublic);

module.exports = router;
