'use strict';

const { Pool } = require('pg');
const config = require('../config');

if (!config.DATABASE_URL) {
  console.warn('[db] DATABASE_URL is not set — DB operations will fail');
}

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  // Railway's public Postgres endpoint requires SSL; the internal endpoint does not.
  // rejectUnauthorized:false is the standard config for Railway-managed Postgres.
  ssl: config.IS_PROD ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  // Idle clients can emit errors (e.g. network blip). Log and keep going.
  console.error('[db] unexpected pool error', err);
});

module.exports = pool;
