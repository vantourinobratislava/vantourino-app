'use strict';

const admins = require('../src/services/admins');
const pool = require('../src/db/pool');

async function main() {
  const [, , username, password] = process.argv;
  if (!username || !password) {
    console.error('Usage: node scripts/create-admin.js <username> <password>');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('Refusing: password must be at least 10 characters.');
    process.exit(1);
  }

  try {
    const existing = await admins.findByUsername(username);
    if (existing) {
      console.error(`Admin "${username}" already exists (id=${existing.id}).`);
      process.exit(1);
    }
    const admin = await admins.createAdmin(username, password);
    console.log(`Created admin: id=${admin.id} username=${admin.username}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
