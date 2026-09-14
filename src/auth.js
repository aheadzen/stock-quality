// Auth core: bcryptjs password hashing, opaque session tokens persisted in
// SQLite, cookie helpers, request middleware, login rate limit, and HTTP
// handler bodies for /api/auth/*.
//
// Sessions: 32-byte hex token, 7-day TTL, HttpOnly + SameSite=Strict cookie.
// The token is the only thing the client holds — server can revoke at any time
// via DELETE FROM sessions.

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getDb, getStatements, initDb } from './db.js';
import { logInfo, logWarn } from './logger.js';
import { constantTimeVerifyPassword, findUserByEmail, findUserById } from './users.js';

const BCRYPT_ROUNDS = 12;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'sid';
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const BATCH_RATE_LIMIT_MAX = 200;
const BATCH_SIZE_LIMIT = 50;

const isProd = process.env.NODE_ENV === 'production';

// In-memory rate-limit maps. State does not persist across restarts
// (intentional — same model as the queue's 429 backoff).
const loginAttempts = new Map(); // ip -> { count, resetAt }
const batchAttempts = new Map(); // userId -> { count, resetAt }

export async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

export function createSession(userId) {
  initDb();
  const s = getStatements();
  const id = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  s.insertSession.run(id, userId, expiresAt, now);
  return { id, expiresAt };
}

export function destroySession(id) {
  if (!id) return 0;
  initDb();
  const s = getStatements();
  return s.deleteSession.run(id).changes;
}

export function destroyAllSessionsForUser(userId) {
  if (!userId) return 0;
  initDb();
  const s = getStatements();
  return s.deleteSessionsForUser.run(userId).changes;
}

export function findUserBySessionToken(id) {
  if (!id) return null;
  initDb();
  const s = getStatements();
  const row = s.findSession.get(id, Date.now());
  if (!row) return null;
  if (!row.user_id || !row.email) return null; // user deleted
  return {
    id: row.user_id,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
  };
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, secure = isProd } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (typeof maxAge === 'number') parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(name) {
  return serializeCookie(name, '', { maxAge: 0 });
}

export function attachUser(req) {
  const cookies = parseCookies(req);
  const sid = cookies[COOKIE_NAME];
  if (sid) {
    const user = findUserBySessionToken(sid);
    if (user) {
      req.user = user;
      req.sessionId = sid;
      return user;
    }
  }
  return null;
}

// Returns the user object on success, or null + sets res status on failure.
export function requireAuth(req, res) {
  const user = req.user || attachUser(req);
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Authentication required' }));
    return null;
  }
  return user;
}

export function requireAdmin(req, res) {
  const user = req.user || attachUser(req);
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Authentication required' }));
    return null;
  }
  if (user.role !== 'admin') {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Admin access required' }));
    return null;
  }
  return user;
}

export function loginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { ok: true, retryAfter: 0 };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { ok: true, retryAfter: 0 };
}

export function batchRateLimit(userId) {
  const now = Date.now();
  const entry = batchAttempts.get(userId);
  if (!entry || entry.resetAt <= now) {
    batchAttempts.set(userId, { count: 1, resetAt: now + BATCH_RATE_LIMIT_WINDOW_MS });
    return { ok: true, retryAfter: 0 };
  }
  if (entry.count >= BATCH_RATE_LIMIT_MAX) {
    return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { ok: true, retryAfter: 0 };
}

export function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

// ---- HTTP handler bodies for /api/auth/* ----

export async function handleRegister(req, res, { readJsonBody, sendJson, logInfo, logWarn }) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  const email = (body.email || '').toString().trim().toLowerCase();
  const password = (body.password || '').toString();
  if (!email || !password) {
    return sendJson(res, 400, { error: 'email and password are required' });
  }
  if (password.length < 8) {
    return sendJson(res, 400, { error: 'Password must be at least 8 characters' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return sendJson(res, 400, { error: 'Invalid email format' });
  }
  const existing = findUserByEmail(email);
  if (existing) {
    return sendJson(res, 409, { error: 'Email already registered' });
  }
  let user;
  try {
    const { createUser } = await import('./users.js');
    user = await createUser(email, password);
  } catch (err) {
    logWarn('auth', `register failed for "${email}": ${err.message || err}`);
    return sendJson(res, 500, { error: err.message || 'Registration failed' });
  }
  const sess = createSession(user.id);
  res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, sess.id, {
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  }));
  logInfo('auth', `registered ${user.email} (id=${user.id}, role=${user.role})`);
  return sendJson(res, 200, {
    user: { id: user.id, email: user.email, role: user.role },
  });
}

export async function handleLogin(req, res, { readJsonBody, sendJson, logInfo, logWarn }) {
  const ip = getClientIp(req);
  const limit = loginRateLimit(ip);
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return sendJson(res, 429, { error: 'Too many login attempts. Try again later.' });
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  const email = (body.email || '').toString().trim().toLowerCase();
  const password = (body.password || '').toString();
  if (!email || !password) {
    return sendJson(res, 400, { error: 'email and password are required' });
  }
  const user = findUserByEmail(email);
  const ok = await constantTimeVerifyPassword(password, user?.password_hash ?? null);
  if (!user || !ok) {
    logWarn('auth', `login failed for "${email}" from ${ip}`);
    return sendJson(res, 401, { error: 'Invalid email or password' });
  }
  const sess = createSession(user.id);
  res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, sess.id, {
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  }));
  logInfo('auth', `login ok ${user.email} (id=${user.id}, role=${user.role}) from ${ip}`);
  return sendJson(res, 200, {
    user: { id: user.id, email: user.email, role: user.role },
  });
}

export function handleLogout(req, res, { sendJson, logInfo }) {
  if (req.sessionId) destroySession(req.sessionId);
  res.setHeader('Set-Cookie', clearCookie(COOKIE_NAME));
  if (req.user) logInfo('auth', `logout ${req.user.email}`);
  return sendJson(res, 200, { ok: true });
}

export function handleLogoutAll(req, res, { sendJson, logInfo }) {
  if (req.user) {
    const n = destroyAllSessionsForUser(req.user.id);
    logInfo('auth', `logout-all ${req.user.email} (${n} sessions)`);
  }
  res.setHeader('Set-Cookie', clearCookie(COOKIE_NAME));
  return sendJson(res, 200, { ok: true });
}

export function handleMe(req, res, { sendJson }) {
  if (!req.user) return sendJson(res, 401, { error: 'Not authenticated' });
  return sendJson(res, 200, {
    user: {
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
    },
  });
}

export function getBatchSizeLimit() {
  return BATCH_SIZE_LIMIT;
}

export { COOKIE_NAME };