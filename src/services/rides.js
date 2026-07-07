'use strict';

const pool = require('../db/pool');
const HttpError = require('../utils/httpError');

/* ===================== Rides (Phase 1) ===================== */

/**
 * Manually-managed list of scheduled rides for today's operational overview.
 * Admin-only. Date and time are stored naively (no TZ conversion) — what the
 * operator types is what's saved and displayed. See migration 013 for the
 * rationale on the schema shape.
 */

// Match the CHECK constraint in migration 013. Extending this is a one-line
// change here + a constraint relax in a future migration.
const ALLOWED_STATUSES = ['scheduled', 'completed', 'cancelled'];

function rowToDto(r) {
  return {
    id: r.id,
    rideDate: typeof r.ride_date === 'string' ? r.ride_date : r.ride_date.toISOString().slice(0, 10),
    startTime: typeof r.start_time === 'string'
      ? r.start_time.slice(0, 5)
      : String(r.start_time).slice(0, 5),
    title: r.title,
    guestCount: Number(r.guest_count) || 0,
    notes: r.notes || null,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Validate + normalize the writable fields. Throws HttpError(400) on bad input. */
function normalizeWritable(payload, { partial = false } = {}) {
  const out = {};

  // ride_date — required on create. Accepts 'YYYY-MM-DD'. We don't accept
  // full timestamps because that invites silent TZ shifts.
  if (payload.rideDate !== undefined) {
    const s = String(payload.rideDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, 'rideDate must be YYYY-MM-DD');
    // Cheap sanity check — Date.parse on YYYY-MM-DD treats as UTC midnight; the
    // resulting date components must roundtrip to catch impossible dates like
    // 2026-02-31.
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
      throw new HttpError(400, 'rideDate is not a valid calendar date');
    }
    out.ride_date = s;
  } else if (!partial) {
    throw new HttpError(400, 'rideDate is required');
  }

  // start_time — required on create. Accepts 'HH:MM' (24h) or 'HH:MM:SS'.
  if (payload.startTime !== undefined) {
    const raw = String(payload.startTime || '').trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(raw)) {
      throw new HttpError(400, 'startTime must be HH:MM (24h)');
    }
    out.start_time = raw.length === 5 ? `${raw}:00` : raw;
  } else if (!partial) {
    throw new HttpError(400, 'startTime is required');
  }

  // title — required, capped at 255.
  if (payload.title !== undefined) {
    const t = String(payload.title || '').trim();
    if (t.length === 0) throw new HttpError(400, 'title is required');
    out.title = t.slice(0, 255);
  } else if (!partial) {
    throw new HttpError(400, 'title is required');
  }

  // guest_count — optional, clamped to non-negative integer.
  if (payload.guestCount !== undefined) {
    const n = Number(payload.guestCount);
    if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
      throw new HttpError(400, 'guestCount must be a non-negative integer');
    }
    // Cap at 10_000 to defend against typos becoming bad UI.
    out.guest_count = Math.min(n, 10000);
  } else if (!partial) {
    out.guest_count = 0;
  }

  // notes — optional, capped at 5000 chars to match other free-form fields.
  if (payload.notes !== undefined) {
    const n = payload.notes == null ? null : String(payload.notes);
    out.notes = n == null ? null : n.slice(0, 5000);
  } else if (!partial) {
    out.notes = null;
  }

  // status — optional, validated against ALLOWED_STATUSES.
  if (payload.status !== undefined) {
    const s = String(payload.status || '').trim().toLowerCase();
    if (!ALLOWED_STATUSES.includes(s)) {
      throw new HttpError(400, `status must be one of: ${ALLOWED_STATUSES.join(', ')}`);
    }
    out.status = s;
  } else if (!partial) {
    out.status = 'scheduled';
  }

  return out;
}

/** Single ride DTO; 404 on missing. */
async function getRide(id) {
  const rid = Number(id);
  if (!Number.isInteger(rid) || rid < 1) throw new HttpError(400, 'invalid id');
  const { rows } = await pool.query(`SELECT * FROM rides WHERE id = $1`, [rid]);
  if (!rows[0]) throw new HttpError(404, 'ride not found');
  return rowToDto(rows[0]);
}

/**
 * Return today's date as YYYY-MM-DD in the operational timezone
 * (Europe/Bratislava). Computing it in JS (rather than via SQL CURRENT_DATE)
 * guarantees the same answer whether the Node process runs in UTC (Railway,
 * Docker) or local. Also makes it trivial to later expose a "view as of
 * date" admin filter.
 */
function todayLocal() {
  // 'en-CA' yields ISO-like YYYY-MM-DD; timeZone forces Bratislava reckoning.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bratislava',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * List rides, grouped into today / upcoming / past. "Today" is computed in
 * Europe/Bratislava (the operational TZ) and passed as a parameter so the
 * result is independent of the server's clock TZ.  Ordering: today + upcoming
 * ascending (next ride first); past descending (most-recently-finished first).
 */
async function listRides() {
  const today = todayLocal();
  const { rows: todayRows } = await pool.query(
    `SELECT * FROM rides WHERE ride_date = $1
       ORDER BY start_time ASC, id ASC`,
    [today]
  );
  const { rows: upcomingRows } = await pool.query(
    `SELECT * FROM rides WHERE ride_date > $1
       ORDER BY ride_date ASC, start_time ASC, id ASC`,
    [today]
  );
  const { rows: pastRows } = await pool.query(
    `SELECT * FROM rides WHERE ride_date < $1
       ORDER BY ride_date DESC, start_time DESC, id DESC
       LIMIT 100`,
    [today]
  );
  return {
    today: todayRows.map(rowToDto),
    upcoming: upcomingRows.map(rowToDto),
    past: pastRows.map(rowToDto),
    todayDate: today, // for the UI's "Today (dd/mm/yyyy)" header
  };
}

async function createRide(payload) {
  const v = normalizeWritable(payload || {}, { partial: false });
  const { rows } = await pool.query(
    `INSERT INTO rides (ride_date, start_time, title, guest_count, notes, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [v.ride_date, v.start_time, v.title, v.guest_count, v.notes, v.status]
  );
  return rowToDto(rows[0]);
}

async function updateRide(id, payload) {
  const rid = Number(id);
  if (!Number.isInteger(rid) || rid < 1) throw new HttpError(400, 'invalid id');
  const v = normalizeWritable(payload || {}, { partial: true });

  const sets = [];
  const params = [rid];
  for (const [col, val] of Object.entries(v)) {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length === 0) throw new HttpError(400, 'nothing to update');
  sets.push(`updated_at = NOW()`);

  const { rows } = await pool.query(
    `UPDATE rides SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    params
  );
  if (!rows[0]) throw new HttpError(404, 'ride not found');
  return rowToDto(rows[0]);
}

async function deleteRide(id) {
  const rid = Number(id);
  if (!Number.isInteger(rid) || rid < 1) throw new HttpError(400, 'invalid id');
  const { rows } = await pool.query(`DELETE FROM rides WHERE id = $1 RETURNING id`, [rid]);
  if (!rows[0]) throw new HttpError(404, 'ride not found');
  return { ok: true, deletedId: rid };
}

module.exports = {
  ALLOWED_STATUSES,
  listRides,
  getRide,
  createRide,
  updateRide,
  deleteRide,
};
