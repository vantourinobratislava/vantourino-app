'use strict';

const HttpError = require('../utils/httpError');

/**
 * Read-through proxy to the BBS Booking REST API. Phase 2 of the Rides
 * module: no DB persistence — every request fetches fresh from upstream,
 * the UI shows "Last refreshed at HH:MM".
 *
 * The bearer token is server-side only and never sent to the browser.
 * Env vars are read at request time so rotating credentials in Railway
 * doesn't need a restart.
 *
 * On any upstream failure the route returns a 5xx with a clear, leak-free
 * message so the UI can render an "unavailable" state without crashing.
 */

const UPSTREAM_TIMEOUT_MS = 8000;

function configFromEnv() {
  const baseUrl = (process.env.BBS_API_BASE_URL || '').trim();
  const token = (process.env.BBS_API_TOKEN || '').trim();
  return { baseUrl, token, configured: !!(baseUrl && token) };
}

/**
 * Boot-time visibility (no secrets). Called from server.js so config errors
 * surface on startup instead of the first user click.
 */
function describeConfigForBoot() {
  const { baseUrl, token } = configFromEnv();
  return {
    baseUrl: baseUrl || null,
    tokenConfigured: !!token,
  };
}

/**
 * Map an upstream HTTP response to a clean HttpError for our clients.
 * Important: never include the upstream response body in logs/messages —
 * it could echo credentials back.
 */
function mapUpstreamError(status, label) {
  if (status === 401 || status === 403) {
    return new HttpError(502, 'BBS Booking API rejected our credentials');
  }
  if (status === 404) {
    return new HttpError(502, 'BBS Booking endpoint not found — check BBS_API_BASE_URL');
  }
  if (status >= 500) {
    return new HttpError(502, 'BBS Booking API is currently unavailable');
  }
  return new HttpError(502, `BBS Booking API returned ${status} (${label})`);
}

async function callUpstream(pathAndQuery) {
  const { baseUrl, token, configured } = configFromEnv();
  if (!configured) {
    throw new HttpError(503, 'BBS Booking API not configured (set BBS_API_BASE_URL and BBS_API_TOKEN)');
  }
  // Build URL with WHATWG URL so we benefit from input validation and any
  // accidental path traversal in our caller is normalized away.
  let url;
  try {
    url = new URL(pathAndQuery, baseUrl);
  } catch (_err) {
    throw new HttpError(503, 'BBS Booking API base URL is invalid');
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      // Native abort-by-timeout (Node 20+). Cheap GETs; no body to upload.
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortError / network errors. Log enough to debug, never the token.
    const reason = (err && err.name === 'TimeoutError') ? 'timeout' : (err && err.message) || 'network error';
    console.error(`[bbs] upstream GET ${url.pathname} failed: ${reason}`);
    if (err && err.name === 'TimeoutError') throw new HttpError(504, 'BBS Booking API timed out');
    throw new HttpError(502, 'BBS Booking API unreachable');
  }

  console.log(`[bbs] upstream GET ${url.pathname} → ${res.status}`);

  if (!res.ok) {
    throw mapUpstreamError(res.status, url.pathname);
  }

  let body;
  try {
    body = await res.json();
  } catch (_err) {
    throw new HttpError(502, 'Unexpected response from BBS Booking API (not JSON)');
  }

  if (!body || typeof body !== 'object' || !Array.isArray(body.bookings)) {
    throw new HttpError(502, 'Unexpected response from BBS Booking API (missing bookings)');
  }

  return body;
}

/**
 * Normalize a booking row to a stable shape our UI can render without
 * worrying about partial fields. Defensive: every field tolerated as
 * missing; numbers coerced; arrays guaranteed.
 */
function normalizeBooking(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const toStr = (v) => (v == null ? null : String(v));
  const toInt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  };
  // Null-PRESERVING cents coercion for crew pay. Critically different from
  // toInt: a null/absent/invalid value stays null (NOT 0), because for
  // bonuses null means "default handled at day level — do not show", which
  // must never collapse into a misleading €0.00.
  const toCentsOrNull = (v) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };
  // Slot pay block. bonusCents stays null unless WP sends a number;
  // bonusIsOverride is a STRICT boolean — only an explicit true means the
  // bonus is a booking-specific override that may be displayed.
  const payBlock = (rate, bonus, override) => ({
    rateCents: toCentsOrNull(rate),
    bonusCents: toCentsOrNull(bonus),
    bonusIsOverride: override === true,
  });
  return {
    id: raw.id != null ? toStr(raw.id) : (raw.booking_id != null ? toStr(raw.booking_id) : null),
    rideName: toStr(raw.ride_name_en) || null,
    bookingNumber: toStr(raw.booking_number) || null,
    startTime: toStr(raw.start_time) || null,
    endTime: toStr(raw.end_time) || null,
    duration: toStr(raw.duration) || null,
    customerName: toStr(raw.customer_name) || null,
    customerPhone: toStr(raw.customer_phone) || null,
    country: toStr(raw.country) || null,
    groupSize: toInt(raw.group_size),
    extras: Array.isArray(raw.extras) ? raw.extras.map((x) => String(x)).filter(Boolean) : [],
    dueAmountCents: toInt(raw.due_amount_cents),
    // Crew slots. Per the WP contract, *_external_id are the CANONICAL
    // identity values used for free/occupied/mine logic, ownership checks,
    // and roster matching. crew_1/crew_2 are display labels only (a name)
    // and must never drive ownership. driver = slot 1, guide = slot 2.
    crew1ExternalId: toStr(raw.crew_1_external_id) || null,
    crew2ExternalId: toStr(raw.crew_2_external_id) || null,
    crew1Label: toStr(raw.crew_1) || null,
    crew2Label: toStr(raw.crew_2) || null,
    // Slot-specific crew pay (shown only to the admin holding that slot).
    driverPay: payBlock(raw.driver_rate_cents, raw.driver_bonus_cents, raw.driver_bonus_is_override),
    guidePay: payBlock(raw.guide_rate_cents, raw.guide_bonus_cents, raw.guide_bonus_is_override),
  };
}

function normalizeResponse(body) {
  return {
    date: typeof body.date === 'string' ? body.date : null,
    bookings: (body.bookings || []).map(normalizeBooking).filter(Boolean),
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchToday() {
  const body = await callUpstream('/wp-json/bbs/v1/crew-bookings/today');
  return normalizeResponse(body);
}

async function fetchForDate(dateStr) {
  // Defensive: only allow YYYY-MM-DD. Anything else gets a clean 400 before
  // we touch the upstream.
  const s = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new HttpError(400, 'date must be YYYY-MM-DD');
  }
  const body = await callUpstream(`/wp-json/bbs/v1/crew-bookings?date=${encodeURIComponent(s)}`);
  return normalizeResponse(body);
}

/**
 * Fetch all days of a calendar month in one server-side roundtrip from the
 * browser's POV. The upstream API has no month/range endpoint, so we
 * fan-out to `fetchForDate` for each day with a small concurrency cap to
 * avoid hammering upstream.
 *
 * Returns:
 *   {
 *     yearMonth: 'YYYY-MM',
 *     byDate: { 'YYYY-MM-DD': { bookings, date } | { error: string } },
 *     fetchedAt: ISO,
 *   }
 *
 * Per-day errors do not fail the whole call — the affected day is reported
 * with `{ error }` and the rest of the month renders normally.
 */
async function fetchForMonth(yearMonth) {
  const s = String(yearMonth || '').trim();
  if (!/^\d{4}-\d{2}$/.test(s)) {
    throw new HttpError(400, 'yearMonth must be YYYY-MM');
  }
  const [yy, mm] = s.split('-').map(Number);
  // Number of days in the month: day 0 of next month = last day of this month.
  const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();

  const dates = [];
  for (let d = 1; d <= lastDay; d++) {
    dates.push(`${s}-${String(d).padStart(2, '0')}`);
  }

  // Bounded concurrency — avoid 30 parallel upstream calls.
  const MAX_CONCURRENT = 8;
  const byDate = {};
  let cursor = 0;
  async function worker() {
    while (cursor < dates.length) {
      const i = cursor++;
      const d = dates[i];
      try {
        const r = await fetchForDate(d);
        byDate[d] = { date: r.date || d, bookings: r.bookings };
      } catch (err) {
        // Per-day failure: record and move on. The whole call still succeeds.
        byDate[d] = { error: (err && err.message) || 'fetch failed' };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, dates.length) }, worker));

  return {
    yearMonth: s,
    byDate,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  fetchToday,
  fetchForDate,
  fetchForMonth,
  describeConfigForBoot,
  _internals: { normalizeBooking },
};
