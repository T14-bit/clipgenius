import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dirs } from './config.js';

// Session secret: from .env, else generated once and kept in data/secret.txt.
const secretFile = path.join(dirs.data, 'secret.txt');
const SECRET = process.env.SESSION_SECRET || (() => {
  try { return fs.readFileSync(secretFile, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, s, { mode: 0o600 });
  return s;
})();

export const COOKIE = 'cg_session';
const DAYS = 30;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [s, h] = String(stored).split(':');
  if (!s || !h) return false;
  const d = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
  const hb = Buffer.from(h, 'hex');
  return d.length === hb.length && crypto.timingSafeEqual(d, hb);
}

const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
export function makeToken(userId) {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: Date.now() + DAYS * 864e5 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
export function readToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const want = Buffer.from(sign(payload)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const { u, e } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return e > Date.now() ? u : null;
  } catch { return null; }
}
export function parseCookies(h = '') {
  return Object.fromEntries(h.split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter(([k]) => k));
}
export const cookieHeader = (token) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DAYS * 86400}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
export const clearCookie = `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
