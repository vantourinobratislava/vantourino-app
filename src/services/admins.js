'use strict';

const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const HttpError = require('../utils/httpError');

const BCRYPT_ROUNDS = 12;

/**
 * Role ladder, most-privileged first. A user with role at index N can do
 * everything roles at indexes ≥ N can do.
 *
 * Phase 1A only stores the role on the admin row. Phase 1B will use
 * `requireRole(min)` middleware to enforce per-route minimums. Phase 1C
 * adds the user management UI.
 */
const ROLES = ['super_admin', 'manager', 'operator', 'viewer'];
const DEFAULT_ROLE = 'super_admin';

/* ===================== Phase 1C-A: per-admin permissions =====================
 *
 * Permissions live alongside roles. The role determines *what kind of action*
 * a user may take inside a module (read vs edit vs operate); permissions
 * determine *which modules* they may touch. Both must pass for a gated
 * route to admit the user.
 *
 * Storage: a JSONB column `admins.permissions`. NULL means "use the role
 * baseline" so existing rows behave exactly as before. A non-null value is
 * a partial override map of `{key: boolean}`. Unknown keys are rejected
 * at write time via the canonical PERMISSION_KEYS allowlist; at read time
 * they're ignored.
 *
 * For super_admin, permissions are bypassed entirely (effective map is all
 * true). This guarantees super_admin can never be locked out of anything,
 * even by a malicious payload.
 */

const PERMISSION_KEYS = [
  // Top-level modules (each maps to a menu tile + a backend surface).
  'calendar',
  'rides',
  'rules',
  'sirups',
  'audioguides',
  'challenges',
  // Challenges sub-permissions.
  'challenges.manage_quizzes',
  'challenges.create_quiz',
  'challenges.session_history',
];

// Role baselines — used when an admin row has permissions = NULL, or when
// a key is missing from a partial override map.
//
// super_admin: bypassed by the resolver (always true).
// manager: every module on, every sub-flag on — backward compatible with 1B.
// operator: every module on (they need read access during tours);
//   sub-flags shaped for ops — they can see session history, but cannot
//   manage quizzes or create new ones. Easily overridden per admin.
const ROLE_PERMISSION_DEFAULTS = {
  super_admin: PERMISSION_KEYS.reduce((m, k) => (m[k] = true, m), {}),
  manager: PERMISSION_KEYS.reduce((m, k) => (m[k] = true, m), {}),
  operator: {
    calendar: true,
    rides: true,
    rules: true,
    sirups: true,
    audioguides: true,
    challenges: true,
    'challenges.manage_quizzes': false,
    'challenges.create_quiz': false,
    'challenges.session_history': true,
  },
  // viewer is currently unused but kept in ROLES for forward-compat.
  viewer: {
    calendar: true,
    rides: true,
    rules: true,
    sirups: true,
    audioguides: true,
    challenges: false,
    'challenges.manage_quizzes': false,
    'challenges.create_quiz': false,
    'challenges.session_history': false,
  },
};

function isKnownPermissionKey(k) {
  return typeof k === 'string' && PERMISSION_KEYS.includes(k);
}

/**
 * Resolve the effective permission map for an admin.
 *
 * - super_admin → all true, irrespective of the stored override (cannot be
 *   restricted by anyone, even by a malicious POST).
 * - other roles → role baseline merged with the stored override (override
 *   wins per key). NULL/empty override → exactly the role baseline.
 *
 * Always returns a complete map (every PERMISSION_KEYS key present).
 */
function effectivePermissions(admin) {
  const role = admin && admin.role;
  const out = {};
  if (role === 'super_admin') {
    for (const k of PERMISSION_KEYS) out[k] = true;
    return out;
  }
  const baseline = ROLE_PERMISSION_DEFAULTS[role] || {};
  const override = (admin && admin.permissions && typeof admin.permissions === 'object') ? admin.permissions : null;
  for (const k of PERMISSION_KEYS) {
    if (override && Object.prototype.hasOwnProperty.call(override, k) && typeof override[k] === 'boolean') {
      out[k] = override[k];
    } else {
      out[k] = !!baseline[k];
    }
  }
  return out;
}

function hasPermission(admin, key) {
  const eff = effectivePermissions(admin);
  return !!eff[key];
}

/**
 * Validate + normalize a partial permissions payload. Accepts:
 *   - null → caller wants to reset to "use role defaults".
 *   - {} → same as null.
 *   - { key: boolean, ... } where every key is in PERMISSION_KEYS.
 * Throws HttpError(400) on unknown keys or non-boolean values.
 *
 * Returns null (reset) or the normalized object (subset of PERMISSION_KEYS).
 */
function validatePermissionsPayload(input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'permissions must be an object or null');
  }
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!isKnownPermissionKey(k)) {
      throw new HttpError(400, `unknown permission key: ${k}`);
    }
    if (typeof v !== 'boolean') {
      throw new HttpError(400, `permission "${k}" must be true or false`);
    }
    out[k] = v;
  }
  // Empty object is semantically equivalent to "reset to role defaults" —
  // store NULL so the row stays clean.
  return Object.keys(out).length === 0 ? null : out;
}

function isKnownRole(r) {
  return typeof r === 'string' && ROLES.includes(r);
}

/**
 * True iff `actualRole` is at least as privileged as `minRole`.
 */
function roleSatisfies(actualRole, minRole) {
  const a = ROLES.indexOf(actualRole);
  const b = ROLES.indexOf(minRole);
  if (a < 0 || b < 0) return false;
  return a <= b;
}

// A precomputed bcrypt hash of an impossible-to-match value, used so that
// `verifyPassword` for an unknown username still runs the same bcrypt work
// as the success path. Defends against timing-based username enumeration.
// (Generated once at module load — same cost as any other bcrypt hash.)
const DUMMY_HASH = bcrypt.hashSync('::dummy::no::match::', BCRYPT_ROUNDS);

function rowToDto(r) {
  const base = {
    id: r.id,
    username: r.username,
    role: r.role || DEFAULT_ROLE,
    isActive: r.is_active === undefined ? true : !!r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at || null,
    // Raw override map as stored (null when "use role defaults").
    permissions: r.permissions === undefined ? null : r.permissions,
    // Stable, opaque, public crew identity (UUID text) linking this admin
    // to a WordPress crew member record. null until backfilled. Tolerant
    // of SELECTs that don't include the column (stays null rather than
    // undefined).
    crewExternalId: r.crew_external_id === undefined ? null : (r.crew_external_id || null),
  };
  // Resolved permission map — every PERMISSION_KEYS key present. The
  // resolver short-circuits super_admin to all-true.
  base.effectivePermissions = effectivePermissions(base);
  return base;
}

async function findByUsername(username) {
  const u = String(username || '').trim();
  if (!u) return null;
  // Case-insensitive username match. Stored exactly as typed; compared by
  // LOWER() so 'Admin' and 'admin' are the same login.
  const { rows } = await pool.query(
    `SELECT id, username, password_hash, role, is_active, created_at, updated_at, permissions
       FROM admins
      WHERE LOWER(username) = LOWER($1)
      LIMIT 1`,
    [u]
  );
  return rows[0] || null;
}

async function findById(id) {
  const aid = Number(id);
  if (!Number.isInteger(aid) || aid < 1) return null;
  const { rows } = await pool.query(
    `SELECT id, username, role, is_active, created_at, updated_at, permissions, crew_external_id
       FROM admins
      WHERE id = $1
      LIMIT 1`,
    [aid]
  );
  if (!rows[0]) return null;
  return rowToDto(rows[0]);
}

/**
 * Constant-time-ish credential check. If the username is unknown, we still
 * run a bcrypt compare against a dummy hash so the response time is
 * indistinguishable from a wrong-password case. Always returns false for
 * inactive users (no info leak).
 */
async function verifyCredentials(username, plainPassword) {
  if (!plainPassword) return null;
  const row = await findByUsername(username);
  if (!row || !row.is_active) {
    await bcrypt.compare(String(plainPassword), DUMMY_HASH).catch(() => {});
    return null;
  }
  const ok = await bcrypt.compare(String(plainPassword), row.password_hash);
  if (!ok) return null;
  return rowToDto(row);
}

// Kept for backward compatibility with the existing login route — it still
// calls verifyPassword(plain, hash). Internally now also masked by the
// caller (see adminAuth.js).
async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  return bcrypt.compare(String(plain), hash);
}

async function hashPassword(plain) {
  return bcrypt.hash(String(plain), BCRYPT_ROUNDS);
}

/* ===================== Phase 1A: seeding + role management ===================== */

/**
 * Idempotent admin seed used at server boot. Behavior:
 *
 *   1. If `admins` is non-empty → no-op (returns { action: 'skipped_nonempty' }).
 *      First boot is the only time we ever auto-create a user; from then on,
 *      management is via the UI / dedicated migrations.
 *   2. Else if ADMIN_USERNAME + ADMIN_PASSWORD env are set → insert one
 *      super_admin with a bcrypt-hashed password (action: 'seeded').
 *   3. Else → no-op with a warning so the operator sees it in the boot log
 *      (action: 'no_env_warning'). Login will fail until a row exists.
 *
 * Safe to call repeatedly. Never overwrites existing rows. Logs once.
 */
async function seedSuperAdminIfNeeded() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM admins`);
  const n = rows[0] && Number(rows[0].n);
  if (n > 0) {
    return { action: 'skipped_nonempty', count: n };
  }
  const envUser = (process.env.ADMIN_USERNAME || '').trim();
  const envPass = process.env.ADMIN_PASSWORD || '';
  if (!envUser || !envPass) {
    return { action: 'no_env_warning' };
  }
  // INSERT ... ON CONFLICT DO NOTHING so racing boots both succeed safely.
  const hash = await hashPassword(envPass);
  const ins = await pool.query(
    `INSERT INTO admins (username, password_hash, role, is_active)
     VALUES ($1, $2, 'super_admin', TRUE)
     ON CONFLICT (username) DO NOTHING
     RETURNING id, username, role`,
    [envUser, hash]
  );
  if (ins.rows[0]) return { action: 'seeded', user: ins.rows[0] };
  return { action: 'skipped_race', username: envUser };
}

/* ----- Phase 1C: user management API (defined now, wired later) -----
 * These functions are exported so Phase 1C can build the Users page without
 * touching this service again. They're safe to leave dormant — no route
 * exposes them yet.
 */

async function listAdmins() {
  const { rows } = await pool.query(
    `SELECT id, username, role, is_active, created_at, updated_at, permissions
       FROM admins
      ORDER BY id ASC`
  );
  return rows.map(rowToDto);
}

async function createAdmin({ username, password, role }) {
  const u = String(username || '').trim();
  if (!u) throw new HttpError(400, 'username is required');
  if (!password || String(password).length < 8) {
    throw new HttpError(400, 'password must be at least 8 characters');
  }
  const r = role || 'viewer';
  if (!isKnownRole(r)) throw new HttpError(400, 'invalid role');
  const hash = await hashPassword(password);
  try {
    // crew_external_id starts NULL ("not yet paired"). The app does NOT
    // generate crew identities — super_admin pairs an admin to a WordPress
    // crew member by pasting that member's external_id on the Users page.
    const { rows } = await pool.query(
      `INSERT INTO admins (username, password_hash, role, is_active)
       VALUES ($1, $2, $3, TRUE)
       RETURNING id, username, role, is_active, created_at, updated_at, permissions, crew_external_id`,
      [u, hash, r]
    );
    return rowToDto(rows[0]);
  } catch (err) {
    if (err && err.code === '23505') throw new HttpError(409, 'username already exists');
    throw err;
  }
}

/**
 * Manually set (or clear) an admin's crew_external_id — the link to a
 * WordPress crew member's external_id. super_admin-only at the route
 * layer. The app never generates this value; it is pasted in from WP.
 *
 * Pass null/'' to UNPAIR (stored as NULL). Whitespace is trimmed; an
 * all-whitespace value clears the pairing rather than masquerading as set.
 */
async function setCrewExternalId(id, value) {
  const aid = Number(id);
  if (!Number.isInteger(aid) || aid < 1) throw new HttpError(400, 'invalid id');

  let v = null;
  if (value != null) {
    v = String(value).trim();
    if (v === '') {
      v = null; // explicit unpair
    } else {
      if (v.length > 64) throw new HttpError(400, 'crew_external_id must be 64 characters or fewer');
      // Reject control characters; WP ids are "uuid-or-stable-id", so we
      // keep the charset permissive otherwise (no format lock-in).
      if (/[\u0000-\u001f\u007f]/.test(v)) throw new HttpError(400, 'crew_external_id contains invalid characters');
    }
  }

  const { rows } = await pool.query(
    `UPDATE admins SET crew_external_id = $2, updated_at = NOW() WHERE id = $1
     RETURNING id, username, role, is_active, created_at, updated_at, permissions, crew_external_id`,
    [aid, v]
  );
  if (!rows[0]) throw new HttpError(404, 'admin not found');
  return rowToDto(rows[0]);
}

async function setRole(id, role) {
  if (!isKnownRole(role)) throw new HttpError(400, 'invalid role');
  const aid = Number(id);
  if (!Number.isInteger(aid) || aid < 1) throw new HttpError(400, 'invalid id');
  const { rows } = await pool.query(
    `UPDATE admins SET role = $2, updated_at = NOW() WHERE id = $1
     RETURNING id, username, role, is_active, created_at, updated_at, permissions`,
    [aid, role]
  );
  if (!rows[0]) throw new HttpError(404, 'admin not found');
  return rowToDto(rows[0]);
}

async function setActive(id, isActive) {
  const aid = Number(id);
  if (!Number.isInteger(aid) || aid < 1) throw new HttpError(400, 'invalid id');
  const { rows } = await pool.query(
    `UPDATE admins SET is_active = $2, updated_at = NOW() WHERE id = $1
     RETURNING id, username, role, is_active, created_at, updated_at, permissions`,
    [aid, !!isActive]
  );
  if (!rows[0]) throw new HttpError(404, 'admin not found');
  return rowToDto(rows[0]);
}

async function setPassword(id, newPassword) {
  if (!newPassword || String(newPassword).length < 8) {
    throw new HttpError(400, 'password must be at least 8 characters');
  }
  const aid = Number(id);
  if (!Number.isInteger(aid) || aid < 1) throw new HttpError(400, 'invalid id');
  const hash = await hashPassword(newPassword);
  const { rows } = await pool.query(
    `UPDATE admins SET password_hash = $2, updated_at = NOW() WHERE id = $1
     RETURNING id`,
    [aid, hash]
  );
  if (!rows[0]) throw new HttpError(404, 'admin not found');
  return { ok: true };
}

/**
 * Set or reset the per-admin permission override map.
 *
 * Pass null/undefined/{} to reset to "use role defaults" (column → NULL).
 * Pass a partial { key: boolean, ... } map; the resolver merges with the
 * role baseline at read time.
 *
 * Throws HttpError(400) on unknown keys or non-boolean values.
 * Throws HttpError(404) if no admin with that id.
 */
async function setPermissions(id, payload) {
  const aid = Number(id);
  if (!Number.isInteger(aid) || aid < 1) throw new HttpError(400, 'invalid id');
  const normalized = validatePermissionsPayload(payload);
  // JSONB column accepts null directly; pg encodes JS null as SQL NULL.
  const { rows } = await pool.query(
    `UPDATE admins SET permissions = $2, updated_at = NOW() WHERE id = $1
     RETURNING id, username, role, is_active, created_at, updated_at, permissions`,
    [aid, normalized]
  );
  if (!rows[0]) throw new HttpError(404, 'admin not found');
  return rowToDto(rows[0]);
}

module.exports = {
  // Existing API (preserved)
  findByUsername,
  findById,
  verifyPassword,
  hashPassword,
  createAdmin,

  // Phase 1A
  ROLES,
  DEFAULT_ROLE,
  isKnownRole,
  roleSatisfies,
  verifyCredentials,
  seedSuperAdminIfNeeded,

  // Phase 1C-A — permissions
  PERMISSION_KEYS,
  ROLE_PERMISSION_DEFAULTS,
  isKnownPermissionKey,
  effectivePermissions,
  hasPermission,
  validatePermissionsPayload,
  setPermissions,

  // Phase 1C-B — user management (dormant — no routes yet)
  listAdmins,
  setRole,
  setActive,
  setPassword,

  // Crew claiming — manual pairing to a WordPress crew member's external_id
  setCrewExternalId,
};
