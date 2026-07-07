'use strict';

const express = require('express');
const requireAdmin = require('../middleware/requireAdmin');
const { requireRole, requirePermission } = requireAdmin;
const modules = require('../services/modules');

// Public router → mounted at /api/modules
const publicRouter = express.Router();
// Admin router → mounted at /api/admin/modules
const adminRouter = express.Router();
adminRouter.use(requireAdmin);

/* ----- Rules ----- */
publicRouter.get('/rules', async (req, res, next) => {
  try { res.json(await modules.getContent('rules', req.query.lang)); }
  catch (err) { next(err); }
});
adminRouter.get('/rules', requirePermission('rules'), async (req, res, next) => {
  try { res.json(await modules.getContentAll('rules')); }
  catch (err) { next(err); }
});
adminRouter.put('/rules', requirePermission('rules'), requireRole('manager'), async (req, res, next) => {
  try { res.json(await modules.setContent('rules', req.body && req.body.translations)); }
  catch (err) { next(err); }
});

/* ----- Sirups ----- */
publicRouter.get('/sirups', async (req, res, next) => {
  try { res.json({ sirups: await modules.listSirups(req.query.lang) }); }
  catch (err) { next(err); }
});
adminRouter.get('/sirups', requirePermission('sirups'), async (req, res, next) => {
  try { res.json({ sirups: await modules.listSirupsFull() }); }
  catch (err) { next(err); }
});
adminRouter.post('/sirups', requirePermission('sirups'), requireRole('manager'), async (req, res, next) => {
  try { res.status(201).json({ sirup: await modules.createSirup(req.body || {}) }); }
  catch (err) { next(err); }
});
adminRouter.patch('/sirups/:id', requirePermission('sirups'), requireRole('manager'), async (req, res, next) => {
  try { res.json({ sirup: await modules.updateSirup(req.params.id, req.body || {}) }); }
  catch (err) { next(err); }
});
adminRouter.delete('/sirups/:id', requirePermission('sirups'), requireRole('manager'), async (req, res, next) => {
  try { res.json(await modules.deleteSirup(req.params.id)); }
  catch (err) { next(err); }
});

module.exports = { publicRouter, adminRouter };
