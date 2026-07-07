'use strict';

const HttpError = require('../utils/httpError');

/**
 * Crew-claiming proxy to the BBS (WordPress) Booking REST API.
 *
 * WordPress is the source of truth for crew assignments. This module never
 * stores or mutates assignment state locally — it forwards to WP, which
 * performs an atomic conditional UPDATE so the race between two admins
 * claiming the same slot is resolved in the database that owns the row.
 *
 * Identity: the caller's stable, opaque `crew_external_id` is injected
 * server-side from the session (see routes/rides.js). The browser never
 * names who it is assigning — an admin can only ever claim AS themselves.
 *
 * Reuses the same env + timeout discipline as bbsBookings; the bearer
 * token is server-side only and never logged.
 */

const UPSTREAM_TIMEOUT_MS = 8000;
const VALID_SLOTS = new Set(['driver', 'guide']);

function configFromEnv() {
  const baseUrl = (process.env.BBS_API_BASE_URL || '').trim();
  const token = (process.env.BBS_API_TOKEN || '').trim();
  return { baseUrl, token, configured: !!(baseUrl && token) };
}

/**
 * Map an upstream HTTP status to a clean HttpError. WP's documented
 * statuses pass through with intent preserved:
 *   409 → slot already occupied (claim) / not held by you (unclaim)
 *   404 → unknown booking
 *   422 → external id is not a recognized active crew member
 * Never include the upstream body verbatim — it could echo credentials.
 */
function mapUpstreamError(status, label) {
  if (status === 401 || status === 403) {
    return new HttpError(502, 'BBS Booking API rejected our credentials');
  }
  if (status === 404) {
    return new HttpError(404, 'Booking not found');
  }
  if (status === 409) {
    return new HttpError(409, 'That crew slot is already taken');
  }
  if (status === 422) {
    return new HttpError(422, 'You are not a recognized crew member');
  }
  if (status >= 500) {
    return new HttpError(502, 'BBS Booking API is currently unavailable');
  }
  return new HttpError(502, `BBS Booking API returned ${status} (${label})`);
}

async function callUpstream(pathAndQuery, { method = 'GET', body = null } = {}) {
  const { baseUrl, token, configured } = configFromEnv();
  if (!configured) {
    throw new HttpError(503, 'BBS Booking API not configured (set BBS_API_BASE_URL and BBS_API_TOKEN)');
  }
  let url;
  try {
    url = new URL(pathAndQuery, baseUrl);
  } catch (_err) {
    throw new HttpError(503, 'BBS Booking API base URL is invalid');
  }

  const init = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  };
  if (body != null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const reason = (err && err.name === 'TimeoutError') ? 'timeout' : (err && err.message) || 'network error';
    console.error(`[bbs] upstream ${method} ${url.pathname} failed: ${reason}`);
    if (err && err.name === 'TimeoutError') throw new HttpError(504, 'BBS Booking API timed out');
    throw new HttpError(502, 'BBS Booking API unreachable');
  }

  console.log(`[bbs] upstream ${method} ${url.pathname} → ${res.status}`);

  if (!res.ok) {
    throw mapUpstreamError(res.status, url.pathname);
  }

  let payload;
  try {
    payload = await res.json();
  } catch (_err) {
    throw new HttpError(502, 'Unexpected response from BBS Booking API (not JSON)');
  }
  return payload;
}

function assertSlot(slot) {
  const s = String(slot || '').trim().toLowerCase();
  if (!VALID_SLOTS.has(s)) throw new HttpError(400, 'slot must be "driver" or "guide"');
  return s;
}

function assertBookingId(bookingId) {
  const s = String(bookingId || '').trim();
  // Conservative: allow digits and a few id-safe chars; reject anything
  // that could be path traversal before it reaches the upstream URL.
  if (!s || !/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new HttpError(400, 'invalid booking id');
  return s;
}

function normalizeAssignment(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const toStr = (v) => (v == null ? null : String(v));
  // The write endpoints return the updated booking. Mirror the read
  // contract: *_external_id are the canonical identity; crew_1/crew_2 are
  // display labels. Tolerate the id being returned as `id` or `booking_id`.
  return {
    bookingId: toStr(p.booking_id) || toStr(p.id) || null,
    crew1ExternalId: toStr(p.crew_1_external_id) || null,
    crew2ExternalId: toStr(p.crew_2_external_id) || null,
    crew1Label: toStr(p.crew_1) || null,
    crew2Label: toStr(p.crew_2) || null,
  };
}

/** Read the crew roster: external id → display name (+ active flag). */
async function getRoster() {
  const payload = await callUpstream('/wp-json/bbs/v1/crew');
  const list = payload && Array.isArray(payload.crew) ? payload.crew : null;
  if (!list) throw new HttpError(502, 'Unexpected response from BBS Booking API (missing crew)');
  return list
    .map((c) => {
      if (!c || typeof c !== 'object') return null;
      const externalId = c.external_id == null ? null : String(c.external_id);
      if (!externalId) return null;
      return {
        externalId,
        displayName: c.display_name == null ? null : String(c.display_name),
        active: c.active === undefined ? true : !!c.active,
      };
    })
    .filter(Boolean);
}

/** Claim a free slot for `externalId`. WP enforces atomicity; 409 if taken. */
async function claimSlot({ bookingId, slot, externalId }) {
  const id = assertBookingId(bookingId);
  const s = assertSlot(slot);
  const ext = String(externalId || '').trim();
  if (!ext) throw new HttpError(400, 'missing crew identity');
  const payload = await callUpstream(
    `/wp-json/bbs/v1/crew-bookings/${encodeURIComponent(id)}/claim`,
    { method: 'POST', body: { slot: s, external_id: ext } }
  );
  return normalizeAssignment(payload);
}

/** Release a slot held by `externalId`. 409 if not held by them. */
async function unclaimSlot({ bookingId, slot, externalId }) {
  const id = assertBookingId(bookingId);
  const s = assertSlot(slot);
  const ext = String(externalId || '').trim();
  if (!ext) throw new HttpError(400, 'missing crew identity');
  const payload = await callUpstream(
    `/wp-json/bbs/v1/crew-bookings/${encodeURIComponent(id)}/unclaim`,
    { method: 'POST', body: { slot: s, external_id: ext } }
  );
  return normalizeAssignment(payload);
}

module.exports = {
  getRoster,
  claimSlot,
  unclaimSlot,
  // exported for tests
  _internals: { mapUpstreamError, assertSlot, assertBookingId, normalizeAssignment },
};
