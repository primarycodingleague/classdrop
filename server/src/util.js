import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const uid = () => crypto.randomBytes(6).toString('base64url').replace(/[^a-zA-Z0-9]/g, 'x');

/* Read a request body as a Buffer, refusing anything over `limit` bytes. */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, `too large — the limit is ${Math.round(limit / 1048576)} MB`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJSON(req, limit = 12 * 1048576) {
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch (e) { throw new HttpError(400, 'body is not valid JSON'); }
}

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const badKey = k => BAD_KEYS.has(String(k));
/* true if any object in the tree uses a key that would alter a prototype when merged */
export function hasBadKeys(v, depth = 0) {
  if (depth > 64) return true;
  if (Array.isArray(v)) return v.some(x => hasBadKeys(x, depth + 1));
  if (v && typeof v === 'object') return Object.keys(v).some(k => badKey(k) || hasBadKeys(v[k], depth + 1));
  return false;
}

export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

/* NCSC password guidance: a deny list of the most common choices beats complexity rules.
   Ten characters is the floor; on top of that we refuse the passwords every breach list
   starts with, anything built on "password"/"classdrop"/"school", and keyboard runs. */
const COMMON = new Set(`password password1 password12 password123 password1234 passw0rd p@ssword p@ssw0rd 1234567890 12345678910 123456789012
qwertyuiop qwertyuiop1 qwerty1234 qwerty12345 1q2w3e4r5t 1qaz2wsx3edc abcdefghij abcdefghijk abc123abc123 iloveyou12 iloveyou123
letmein123 welcome123 welcome1234 administrator admin123456 changeme123 trustno1234 sunshine123 princess123 football123
baseball123 dragon12345 monkey12345 master12345 superman123 batman12345 michael12345 jennifer123 computer123 internet123
teacher123 teacher1234 school12345 primary123 classroom1 classroom123 september1 september2026 january2026 summer2026`.split(/\s+/));
export function weakPassword(pw) {
  const p = String(pw || '');
  if (p.length < 10) return 'password must be at least 10 characters';
  const low = p.toLowerCase();
  const bare = low.replace(/[^a-z0-9]/g, '');
  if (COMMON.has(low) || COMMON.has(bare)) return 'that password is on the list of most common passwords — choose something only you would think of';
  if (/^(.)\1+$/.test(bare) || /^(..)\1+$/.test(bare)) return 'that password repeats one pattern — choose something longer and less regular';
  if (/^(password|classdrop|school|qwerty|123456|abcdef)/.test(bare) || /^\d+$/.test(bare)) return 'that password starts with something everyone tries first — choose something only you would think of';
  return null;
}
