'use strict';

const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows: applied } = await pool.query('SELECT filename FROM schema_migrations');
  const appliedSet = new Set(applied.map((r) => r.filename));

  let count = 0;
  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [file]
      );
      await client.query('COMMIT');
      console.log(`[migrate] ✓ ${file}`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[migrate] ✗ ${file} — ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  if (count === 0) {
    console.log('[migrate] nothing to apply');
  } else {
    console.log(`[migrate] applied ${count} migration(s)`);
  }
}

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = migrate;
