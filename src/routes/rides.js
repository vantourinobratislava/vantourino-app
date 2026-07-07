'use strict';

const express = require('express');
const requireAdmin = require('../middleware/requireAdmin');
const { requireAnyPermission, requireRole } = requireAdmin;
const bbs = require('../services/bbsBookings');
const bbsCrew = require('../services/bbsCrew');
const HttpError = require('../utils/httpError');

// Admin-only. Mounted at /api/admin/rides — no public router.
//
// Phase 2: read-through proxy to the BBS Booking REST API. No DB persistence.
// The manual CRUD endpoints from Phase 1 are intentionally removed because
// the UI no longer offers manual rides. The `rides` table and service stay
// on disk (harmless, easy to revive) but are not exposed.
//
// Phase 1C-A: these bookings endpoints feed BOTH the Rides today page AND
// the Calendar page. Permission gate accepts EITHER flag — admins with
// only one of the two still get access to the underlying data.
const adminRouter = express.Router();
adminRouter.use(requireAdmin);
adminRouter.use(requireAnyPermission(['rides', 'calendar']));

adminRouter.get('/bookings/today', async (req, res, next) => {
  try { res.json(await bbs.fetchToday()); }
  catch (err) { next(err); }
});

adminRouter.get('/bookings/by-date', async (req, res, next) => {
  try { res.json(await bbs.fetchForDate(req.query.date)); }
  catch (err) { next(err); }
});

adminRouter.get('/bookings/month', async (req, res, next) => {
  try { res.json(await bbs.fetchForMonth(req.query.yearMonth)); }
  catch (err) { next(err); }
});

/* ---------------- Crew claiming ----------------
 *
 * WordPress is the source of truth and performs the atomic conditional
 * write. These routes are thin forwarders. The caller's stable
 * crew_external_id is injected server-side from req.admin — the browser
 * never names who it is assigning, so an admin can only claim AS
 * themselves.
 *
 * Read (roster) inherits the router gate (rides|calendar). Writes add a
 * role floor of `operator` — in this business the crew who claim are the
 * operators. Authoritative "is this a real, active crew member" is
 * enforced by WP (422 for an unknown external id). */

adminRouter.get('/crew', async (req, res, next) => {
  try { res.json({ crew: await bbsCrew.getRoster() }); }
  catch (err) { next(err); }
});

function callerExternalId(req) {
  const ext = req.admin && req.admin.crewExternalId;
  if (!ext) {
    // Should not happen after the boot backfill, but never forward an
    // empty identity to the upstream.
    throw new HttpError(400, 'Your account has no crew identity yet');
  }
  return ext;
}

adminRouter.post('/bookings/:bookingId/crew/claim', requireRole('operator'), async (req, res, next) => {
  try {
    const result = await bbsCrew.claimSlot({
      bookingId: req.params.bookingId,
      slot: (req.body || {}).slot,
      externalId: callerExternalId(req),
    });
    res.json(result);
  } catch (err) { next(err); }
});

adminRouter.post('/bookings/:bookingId/crew/unclaim', requireRole('operator'), async (req, res, next) => {
  try {
    const result = await bbsCrew.unclaimSlot({
      bookingId: req.params.bookingId,
      slot: (req.body || {}).slot,
      externalId: callerExternalId(req),
    });
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = { adminRouter };
