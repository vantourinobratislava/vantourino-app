'use strict';

const admins = require('../services/admins');

/**
 * Require an authenticated admin. On success, populates `req.admin` with
 * `{ id, username, role, isActive }` so downstream handlers (including the
 * future requireRole middleware in Phase 1B) can read role without a DB
 * round-trip per route.
 *
 * If the session points to a deleted or deactivated admin, the session is
 * destroyed and 401 is returned — no zombie sessions.
 */
async function requireAdmin(req, res, next) {
  try {
    if (!req.session || !req.session.adminId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const admin = await admins.findById(req.session.adminId);
    if (!admin || !admin.isActive) {
      // Session refers to a missing or deactivated admin — clean up.
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.admin = admin;
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * requireRole(minRole) — Phase 1B will mount this on write endpoints. Safe
 * to export now even though no routes use it yet: leaves Phase 1A's
 * behavior identical for every existing endpoint.
 */
function requireRole(minRole) {
  return function (req, res, next) {
    if (!req.admin) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!admins.roleSatisfies(req.admin.role, minRole)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return next();
  };
}

/**
 * requirePermission(key) — Phase 1C-A. Gates a route on a specific
 * permission flag (e.g. 'rules', 'challenges.create_quiz'). super_admin
 * passes by design (the resolver short-circuits to all-true). Other roles
 * pass iff their effective map has the key set true. Place between
 * requireAdmin and requireRole.
 */
function requirePermission(key) {
  return function (req, res, next) {
    if (!req.admin) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const eff = req.admin.effectivePermissions || admins.effectivePermissions(req.admin);
    if (!eff[key]) {
      return res.status(403).json({ error: `Forbidden (permission: ${key})` });
    }
    return next();
  };
}

/**
 * requireAnyPermission([keys]) — gates a route if ANY of the listed
 * permissions is set. Used for endpoints shared between two modules
 * (e.g. the Rides bookings endpoint also feeds the Calendar page).
 */
function requireAnyPermission(keys) {
  const list = Array.isArray(keys) ? keys.slice() : [];
  return function (req, res, next) {
    if (!req.admin) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const eff = req.admin.effectivePermissions || admins.effectivePermissions(req.admin);
    if (!list.some((k) => eff[k])) {
      return res.status(403).json({ error: `Forbidden (permission: any of ${list.join(',')})` });
    }
    return next();
  };
}

module.exports = requireAdmin;
module.exports.requireRole = requireRole;
module.exports.requirePermission = requirePermission;
module.exports.requireAnyPermission = requireAnyPermission;
