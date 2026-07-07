'use strict';

const http = require('http');
const config = require('./src/config');
const app = require('./src/app');
const pool = require('./src/db/pool');
const audioStorage = require('./src/utils/audioStorage');
const bbsBookings = require('./src/services/bbsBookings');
const admins = require('./src/services/admins');

const server = http.createServer(app);

// Create AUDIO_DIR up-front and log it so misconfiguration is obvious in the
// boot logs. The Audioguides library streams files from here; if it's not a
// persistent mount in production, uploaded files will not survive redeploys
// and /api/audio/:id/stream will return 404 even though list/upload work.
try {
  const dir = audioStorage.ensureAudioDir();
  console.log(`[audio] AUDIO_DIR=${dir} (${process.env.AUDIO_DIR ? 'from env' : 'default — set AUDIO_DIR + mount a volume in production'})`);
} catch (err) {
  console.error(`[audio] failed to ensure AUDIO_DIR: ${err.message}`);
}

// BBS Booking API (Rides Phase 2): log config presence so misconfig is
// obvious before the first refresh click. Never logs the token itself.
try {
  const cfg = bbsBookings.describeConfigForBoot();
  if (cfg.baseUrl) {
    console.log(`[bbs] BBS_API_BASE_URL=${cfg.baseUrl} (configured)`);
  } else {
    console.log(`[bbs] BBS_API_BASE_URL=(unset) — Rides will show "API not configured" until set`);
  }
  console.log(`[bbs] BBS_API_TOKEN=${cfg.tokenConfigured ? '*** (configured)' : '(unset)'}`);
} catch (err) {
  console.error(`[bbs] failed to inspect BBS config: ${err.message}`);
}

server.listen(config.PORT, '0.0.0.0', async () => {
  console.log(`[server] listening on http://0.0.0.0:${config.PORT} (${config.NODE_ENV})`);

  // Multi-admin Phase 1A: idempotent first-boot seed of the super_admin from
  // ADMIN_USERNAME/ADMIN_PASSWORD env. On any subsequent boot the admins
  // table is non-empty and this no-ops. If the admins table is empty AND
  // the env is missing, log a loud warning — login is impossible until a
  // row exists. Seed failures are logged but never block the listener.
  try {
    const r = await admins.seedSuperAdminIfNeeded();
    if (r.action === 'seeded') {
      console.log(`[auth] seeded initial super_admin "${r.user.username}" from ADMIN_USERNAME env`);
    } else if (r.action === 'skipped_nonempty') {
      console.log(`[auth] admins table populated (${r.count}), skipping seed`);
    } else if (r.action === 'skipped_race') {
      console.log(`[auth] admin "${r.username}" already exists, no seed needed`);
    } else if (r.action === 'no_env_warning') {
      console.warn(`[auth] admins table is empty AND no ADMIN_USERNAME/ADMIN_PASSWORD env set — login will be impossible until a user is created`);
    }
  } catch (err) {
    console.error(`[auth] seed failed: ${err && err.message ? err.message : err}`);
  }
});

const shutdown = (signal) => {
  console.log(`[server] ${signal} received, shutting down`);
  server.close(async () => {
    try {
      await pool.end();
      console.log('[server] db pool closed');
    } catch (err) {
      console.error('[server] error closing pool', err);
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
