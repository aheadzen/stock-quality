#!/usr/bin/env node
// Bootstrap (or re-bootstrap) an admin user. Idempotent: re-running with the
// same email resets the password and ensures the role is 'admin'.
//
// Usage:
//   node src/seed-admin.js <email> <password>

import process from 'node:process';
import { initDb } from './db.js';
import { findUserByEmail, setUserPassword, setUserRole } from './users.js';
import { createUser } from './users.js';
import { logInfo, logError } from './logger.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    process.stderr.write('Usage: node src/seed-admin.js <email> <password>\n');
    process.exit(2);
  }
  const [emailRaw, password] = args;
  const email = emailRaw.trim().toLowerCase();
  if (!email || !password) {
    process.stderr.write('email and password are required\n');
    process.exit(2);
  }
  if (password.length < 8) {
    process.stderr.write('Password must be at least 8 characters\n');
    process.exit(2);
  }

  initDb();
  const existing = findUserByEmail(email);
  if (existing) {
    await setUserPassword(existing.id, password);
    if (existing.role !== 'admin') setUserRole(existing.id, 'admin');
    logInfo('seed', `admin reset: ${email} (id=${existing.id})`);
    process.stdout.write(`Admin ready: ${email} (id=${existing.id})\n`);
    process.exit(0);
  }

  const user = await createUser(email, password);
  setUserRole(user.id, 'admin');
  logInfo('seed', `admin created: ${email} (id=${user.id})`);
  process.stdout.write(`Admin created: ${email} (id=${user.id})\n`);
  process.exit(0);
}

main().catch((err) => {
  logError('seed', 'seed-admin failed', err);
  process.stderr.write(`seed-admin failed: ${err.message || err}\n`);
  process.exit(1);
});