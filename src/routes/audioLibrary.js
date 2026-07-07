'use strict';

const express = require('express');
const os = require('os');
const multer = require('multer');
const requireAdmin = require('../middleware/requireAdmin');
const { requireRole, requirePermission } = requireAdmin;
const audioLibrary = require('../services/audioLibrary');
const storage = require('../utils/audioStorage');

// Multer writes uploads to a temp dir first; the service moves accepted files
// into AUDIO_DIR. 50 MB cap per file; audio MIME allowlist enforced here and
// again in the service.
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    if (storage.isAllowedMime(file.mimetype)) cb(null, true);
    else cb(null, false); // silently skip non-audio; service returns 400 if none remain
  },
});

// Admin router → mounted at /api/admin/audio
const adminRouter = express.Router();
adminRouter.use(requireAdmin);
// Entire admin surface is the Audioguides module — gated by the
// audioguides permission. Writes additionally need manager+ (Phase 1B).
// Reads pass through with the permission alone.
adminRouter.use(requirePermission('audioguides'));

// Public router → mounted at /api/audio  (streaming only)
const publicRouter = express.Router();

/* ---- List ---- */
adminRouter.get('/', async (req, res, next) => {
  try { res.json({ recordings: await audioLibrary.list() }); }
  catch (err) { next(err); }
});

/* ---- Upload (single or multiple) ---- */
// Accepts field name "files" (multiple) and/or "file" (single).
adminRouter.post(
  '/',
  requireRole('manager'),
  upload.fields([{ name: 'files', maxCount: 20 }, { name: 'file', maxCount: 1 }]),
  async (req, res, next) => {
    try {
      const files = [
        ...((req.files && req.files.files) || []),
        ...((req.files && req.files.file) || []),
      ];
      if (files.length === 0) {
        return res.status(400).json({ error: 'No audio files provided' });
      }
      // Optional title only applies when exactly one file is uploaded.
      const singleTitle = files.length === 1 ? (req.body && req.body.title) : null;
      const created = [];
      for (const f of files) {
        created.push(await audioLibrary.createFromUpload(f, singleTitle));
      }
      res.status(201).json({ recordings: created });
    } catch (err) { next(err); }
  }
);

/* ---- Rename ---- */
adminRouter.patch('/:id', requireRole('manager'), async (req, res, next) => {
  try { res.json({ recording: await audioLibrary.rename(req.params.id, req.body && req.body.title) }); }
  catch (err) { next(err); }
});

/* ---- Replace file (B3): swap underlying file, keep row + guide attachment ---- */
adminRouter.put(
  '/:id/file',
  requireRole('manager'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No audio file provided' });
      const recording = await audioLibrary.replaceFile(req.params.id, req.file);
      res.json({ recording });
    } catch (err) { next(err); }
  }
);

/* ---- Delete ---- */
adminRouter.delete('/:id', requireRole('manager'), async (req, res, next) => {
  try { res.json(await audioLibrary.remove(req.params.id)); }
  catch (err) { next(err); }
});

/* ---- Stream (public; Range-enabled) ---- */
publicRouter.get('/:id/stream', async (req, res, next) => {
  try { await audioLibrary.stream(req.params.id, req, res); }
  catch (err) { next(err); }
});

/* ===================== B2.1: Guides + variants ===================== */

/* ---- Guides: list + create ---- */
adminRouter.get('/guides', async (req, res, next) => {
  try { res.json({ guides: await audioLibrary.listGuides() }); }
  catch (err) { next(err); }
});
adminRouter.post('/guides', requireRole('manager'), async (req, res, next) => {
  try { res.status(201).json({ guide: await audioLibrary.createGuide(req.body || {}) }); }
  catch (err) { next(err); }
});

/* ---- Guides: rename / update / delete ---- */
adminRouter.patch('/guides/:id', requireRole('manager'), async (req, res, next) => {
  try { res.json({ guide: await audioLibrary.renameGuide(req.params.id, req.body || {}) }); }
  catch (err) { next(err); }
});
adminRouter.delete('/guides/:id', requireRole('manager'), async (req, res, next) => {
  try { res.json(await audioLibrary.deleteGuide(req.params.id)); }
  catch (err) { next(err); }
});

/* ---- Attach / detach a recording to a guide language slot ---- */
adminRouter.post('/:id/attach', requireRole('manager'), async (req, res, next) => {
  try {
    const { guideId, lang } = req.body || {};
    res.json({ recording: await audioLibrary.attachRecordingToGuide({
      recordingId: req.params.id, guideId, lang,
    }) });
  } catch (err) { next(err); }
});
adminRouter.post('/:id/detach', requireRole('manager'), async (req, res, next) => {
  try {
    res.json({ recording: await audioLibrary.detachRecordingFromGuide(req.params.id) });
  } catch (err) { next(err); }
});

module.exports = { adminRouter, publicRouter };
