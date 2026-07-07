'use strict';

const express = require('express');
const admins = require('../services/admins');
const requireAdmin = require('../middleware/requireAdmin');
const HttpError = require('../utils/httpError');
const config = require('../config');

const router = express.Router();

// POST /api/admin/login
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      throw new HttpError(400, 'username and password are required');
    }

    // Single timing-safe call that handles "unknown user", "wrong password",
    // and "deactivated user" indistinguishably from the client's POV.
    const admin = await admins.verifyCredentials(String(username), String(password));
    if (!admin) {
      throw new HttpError(401, 'Invalid credentials');
    }

    // Regenerate session id to prevent session fixation
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.adminId = admin.id;
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        // Response shape: existing { id, username } + new `role` (additive).
        res.json({ id: admin.id, username: admin.username, role: admin.role });
      });
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/logout
router.post('/logout', (req, res, next) => {
  if (!req.session) {
    return res.json({ ok: true });
  }
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie(config.COOKIE_NAME);
    res.json({ ok: true });
  });
});

// GET /api/admin/me
router.get('/me', requireAdmin, async (req, res, next) => {
  try {
    // requireAdmin already loaded the admin into req.admin and validated
    // they exist + are active.
    res.json(req.admin);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
