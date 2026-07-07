'use strict';

const express = require('express');
const requireAdmin = require('../middleware/requireAdmin');
const { requireRole } = requireAdmin;
const admins = require('../services/admins');
const pool = require('../db/pool');
const HttpError = require('../utils/httpError');

/*
 * Admin Users management routes (Phase 1C-B).
 *
 * Mounted at /api/admin/users. ALL endpoints are super_admin-only — there
 * is no surface here that a manager or operator can reach.
 *
 * Service methods (`admins.listAdmins`, `createAdmin`, `setRole`,
 * `setActive`, `setPassword`, `setPermissions`) ship in Phase 1C-A and
 * are wrapped here as thin HTTP handlers. The two server-side safety
 * guards added below cannot be bypassed even by direct DB-edit attempts
 * via the API:
 *
 *   1. SELF-PROTECTION — the signed-in super_admin cannot demote
 *      themselves from super_admin or deactivate themselves. Prevents the
 *      classic "you just locked yourself out" footgun.
 *
 *   2. LAST-SUPER-ADMIN PROTECTION — any change that would leave the
 *      system with zero ACTIVE super_admins is rejected. Counts other
 *      active super_admins (excluding the target) and refuses if zero.
 */

const router = express.Router();

router.use(requireAdmin);
router.use(requireRole('super_admin'));

/**
 * Throw HttpError(409) if the requested change would leave zero active
 * super_admins. `targetId` is the user being modified (excluded from the
 * count of "other active super_admins"). Use this BEFORE running the
 * UPDATE that would change role-or-active.
 */
async function assertNotLastSuperAdmin(targetId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM admins
      WHERE role = 'super_admin'
        AND is_active = TRUE
        AND id <> $1`,
    [targetId]
  );
  const others = rows[0] && Number(rows[0].n);
  if (!others || others < 1) {
    throw new HttpError(409, 'cannot remove the last active super_admin');
  }
}

function isSelf(req, targetId) {
  return Number(targetId) === Number(req.admin && req.admin.id);
}

/* ---------------- meta ---------------- */
// Returns the canonical permission key list and per-role baselines so the
// frontend doesn't have to hardcode them. Cheap; no DB hit.
router.get('/meta', (req, res) => {
  res.json({
    roles: admins.ROLES.filter((r) => r !== 'viewer'), // Phase 1 hides 'viewer' from the picker
    permissionKeys: admins.PERMISSION_KEYS,
    roleDefaults: admins.ROLE_PERMISSION_DEFAULTS,
  });
});

/* ---------------- list ---------------- */
router.get('/', async (req, res, next) => {
  try {
    res.json({ admins: await admins.listAdmins() });
  } catch (err) { next(err); }
});

/* ---------------- create ---------------- */
router.post('/', async (req, res, next) => {
  try {
    const { username, password, role } = req.body || {};
    const created = await admins.createAdmin({ username, password, role });
    res.status(201).json({ admin: created });
  } catch (err) { next(err); }
});

/* ---------------- update role ---------------- */
router.patch('/:id/role', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { role } = req.body || {};
    if (!admins.isKnownRole(role)) throw new HttpError(400, 'invalid role');

    // Self-protection: never let signed-in super_admin demote themselves.
    if (isSelf(req, id) && role !== 'super_admin') {
      throw new HttpError(409, 'cannot demote yourself');
    }

    // Last-super-admin protection: if target IS currently super_admin and
    // is being demoted, ensure another active super_admin exists.
    if (role !== 'super_admin') {
      const current = await admins.findById(id);
      if (!current) throw new HttpError(404, 'admin not found');
      if (current.role === 'super_admin' && current.isActive) {
        await assertNotLastSuperAdmin(id);
      }
    }

    res.json({ admin: await admins.setRole(id, role) });
  } catch (err) { next(err); }
});

/* ---------------- activate / deactivate ---------------- */
router.patch('/:id/active', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { isActive } = req.body || {};
    if (typeof isActive !== 'boolean') {
      throw new HttpError(400, 'isActive must be true or false');
    }

    // Self-protection: never let signed-in super_admin deactivate themselves
    // (they would lose access immediately on the next request).
    if (isSelf(req, id) && isActive === false) {
      throw new HttpError(409, 'cannot deactivate yourself');
    }

    // Last-super-admin protection: deactivating an active super_admin who
    // is the only one left.
    if (isActive === false) {
      const current = await admins.findById(id);
      if (!current) throw new HttpError(404, 'admin not found');
      if (current.role === 'super_admin' && current.isActive) {
        await assertNotLastSuperAdmin(id);
      }
    }

    res.json({ admin: await admins.setActive(id, isActive) });
  } catch (err) { next(err); }
});

/* ---------------- set password ---------------- */
router.put('/:id/password', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { password } = req.body || {};
    // Service already enforces length and bcrypts. Response intentionally
    // does NOT echo the password.
    await admins.setPassword(id, password);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ---------------- set permissions (full override or reset) ---------------- */
// Body: { permissions: { ... } | null }. Null/empty → reset to role defaults.
router.put('/:id/permissions', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { permissions } = req.body || {};
    res.json({ admin: await admins.setPermissions(id, permissions) });
  } catch (err) { next(err); }
});

/* ---------------- set crew_external_id (manual WP pairing) ---------------- */
// Body: { crewExternalId: string | null }. Empty/null → unpair (NULL).
// The app does NOT generate this value — super_admin pastes the matching
// WordPress crew member external_id here.
router.put('/:id/crew-external-id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const value = body.crewExternalId;
    res.json({ admin: await admins.setCrewExternalId(id, value) });
  } catch (err) { next(err); }
});

module.exports = router;
