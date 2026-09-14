// User CRUD + password verification with constant-time defense against email
// enumeration. When the email doesn't exist, we still run a bcrypt compare
// against a dummy hash so the wall-clock timing matches a real failure.

import bcrypt from 'bcryptjs';
import { getStatements, initDb } from './db.js';

// bcryptjs of an unguessable 16-byte random password (computed once). Used as
// the comparison target for unknown emails.
const DUMMY_HASH = bcrypt.hashSync(
  // 16 bytes of randomness — generated once at module load. Hashing this is
  // slow on its own (~250ms); the timing equalization depends on that.
  'n9Z1w6yP5cBfLtQ0xKmDjVuEgRsAaOiI',
  12
);

export async function createUser(email, password) {
  initDb();
  const s = getStatements();
  const normalized = (email || '').toString().trim().toLowerCase();
  if (!normalized) throw new Error('email is required');
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const hash = await bcrypt.hash(password, 12);
  const now = Date.now();
  try {
    const id = s.insertUser.run(normalized, hash, 'user', now).lastInsertRowid;
    return { id: Number(id), email: normalized, role: 'user', created_at: now };
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new Error('Email already registered');
    }
    throw err;
  }
}

export function findUserByEmail(email) {
  if (!email) return null;
  initDb();
  const s = getStatements();
  const normalized = email.toString().trim().toLowerCase();
  return s.findUserByEmail.get(normalized) || null;
}

export function findUserById(id) {
  if (!id) return null;
  initDb();
  const s = getStatements();
  return s.findUserById.get(id) || null;
}

export function listUsers(limit = 100) {
  initDb();
  const s = getStatements();
  return s.listUsers.all(limit);
}

export function setUserRole(userId, role) {
  if (!userId) throw new Error('userId is required');
  if (!['user', 'admin'].includes(role)) throw new Error('Invalid role');
  initDb();
  const s = getStatements();
  return s.setUserRole.run(role, userId).changes;
}

export async function setUserPassword(userId, password) {
  if (!userId) throw new Error('userId is required');
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  initDb();
  const s = getStatements();
  const hash = await bcrypt.hash(password, 12);
  return s.updateUserPassword.run(hash, userId).changes;
}

// Cascades via FK: sessions + lists + list_items deleted automatically.
// requests.user_id is set NULL via ON DELETE SET NULL.
export function deleteUser(userId) {
  if (!userId) return 0;
  initDb();
  const s = getStatements();
  return s.deleteUser.run(userId).changes;
}

// Always runs a bcrypt compare (against the dummy hash when the user is
// missing) so callers can't infer email validity from response timing.
export async function constantTimeVerifyPassword(plain, hashOrNull) {
  const compareHash = hashOrNull || DUMMY_HASH;
  return bcrypt.compare(plain || '', compareHash);
}