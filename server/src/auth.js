/* Sign-in for the three kinds of person, and the bearer tokens they get back.
   Staff: email + password. Pupils: class code, pick your name, PIN. Parents: the parent
   code the school already gives out. Passwords and PINs are scrypt-hashed; tokens are
   random and only their SHA-256 is stored. */
import crypto from 'node:crypto';
import { query, withTx } from './db.js';
import { HttpError, uid } from './util.js';

const SESSION_DAYS = 30;
const PIN_RE = /^\d{4,6}$/;

export function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secret), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}
export function verifySecret(secret, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64url');
  const got = crypto.scryptSync(String(secret), Buffer.from(salt, 'base64url'), want.length, { N: 16384, r: 8, p: 1 });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const tokenHash = t => crypto.createHash('sha256').update(t).digest('hex');

/* Brute-force brake: a handful of attempts per key per ten minutes, in memory. Enough
   for a pilot on one server; move to the database if there are ever several. */
const attempts = new Map();
function throttle(key, limit = 10) {
  const now = Date.now();
  const a = attempts.get(key) || { n: 0, reset: now + 10 * 60 * 1000 };
  if (now > a.reset) { a.n = 0; a.reset = now + 10 * 60 * 1000; }
  a.n++;
  attempts.set(key, a);
  if (a.n > limit) throw new HttpError(429, 'too many attempts — try again in a few minutes');
}

async function issueToken({ schoolId, userId, role, childId = null }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400 * 1000);
  await query('insert into sessions (token_hash, school_id, user_id, role, child_id, expires_at) values ($1,$2,$3,$4,$5,$6)',
    [tokenHash(token), schoolId, userId, role, childId, expires]);
  return { token, expires: expires.toISOString(), userId, role, schoolId, childId };
}

/* Resolve the bearer token on a request to { schoolId, userId, role, childId }. */
export async function authenticate(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(\S+)$/i);
  if (!m) throw new HttpError(401, 'sign in first');
  const r = await query('select school_id, user_id, role, child_id from sessions where token_hash = $1 and expires_at > now()', [tokenHash(m[1])]);
  if (!r.rows.length) throw new HttpError(401, 'your sign-in has expired — sign in again');
  const s = r.rows[0];
  return { schoolId: s.school_id, userId: s.user_id, role: s.role, childId: s.child_id, tokenHash: tokenHash(m[1]) };
}

const record = async (schoolId, c, k) => {
  const r = await query('select doc from records where school_id=$1 and collection=$2 and key=$3 and not deleted', [schoolId, c, k]);
  return r.rows[0] ? r.rows[0].doc : null;
};
const putRecord = (q, schoolId, c, k, doc, by) => q(
  `insert into records (school_id, collection, key, doc, deleted, version, updated_by)
   values ($1,$2,$3,$4,false,nextval('record_version'),$5)
   on conflict (school_id, collection, key) do update set doc=excluded.doc, deleted=false,
   version=nextval('record_version'), updated_at=now(), updated_by=excluded.updated_by`,
  [schoolId, c, k, JSON.stringify(doc), by]);

/* POST /schools — a new school with its first office account. Needs the invite code
   PCL gives out, so strangers cannot create schools on the service. */
export async function createSchool(body, env = process.env) {
  const invites = (env.INVITE_CODES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!invites.length) throw new HttpError(503, 'school sign-up is not open on this server');
  if (!invites.includes(String(body.invite || ''))) throw new HttpError(403, 'that invite code is not recognised');
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'a valid email address is needed');
  if (String(body.password || '').length < 10) throw new HttpError(400, 'password must be at least 10 characters');
  const schoolName = String(body.schoolName || '').trim();
  const adminName = String(body.adminName || '').trim();
  if (!schoolName || !adminName) throw new HttpError(400, 'school name and your name are needed');
  const dup = await query('select 1 from accounts where email=$1', [email]);
  if (dup.rows.length) throw new HttpError(409, 'that email already has an account');

  const schoolId = 's-' + uid();
  const userId = 'u-' + uid();
  await withTx(async q => {
    await q('insert into schools_meta (id, name) values ($1,$2)', [schoolId, schoolName]);
    await q('insert into accounts (school_id, user_id, email, pass_hash) values ($1,$2,$3,$4)', [schoolId, userId, email, hashSecret(body.password)]);
    await putRecord(q, schoolId, 'schools', schoolId, { id: schoolId, name: schoolName, adminId: userId, features: {} }, userId);
    await putRecord(q, schoolId, 'users', userId, { id: userId, name: adminName, role: 'admin', alsoTeacher: true, schoolId }, userId);
  });
  return issueToken({ schoolId, userId, role: 'staff' });
}

/* POST /staff — an existing staff account (office or teacher) adds a colleague. */
export async function createStaff(user, body) {
  if (user.role !== 'staff') throw new HttpError(403, 'staff only');
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'a valid email address is needed');
  if (String(body.password || '').length < 10) throw new HttpError(400, 'password must be at least 10 characters');
  const name = String(body.name || '').trim();
  if (!name) throw new HttpError(400, 'a name is needed');
  const role = body.role === 'admin' ? 'admin' : 'teacher';
  const dup = await query('select 1 from accounts where email=$1', [email]);
  if (dup.rows.length) throw new HttpError(409, 'that email already has an account');
  let userId = body.userId ? String(body.userId) : null;
  if (userId) {   // attach a sign-in to a staff member the school already has in its records
    const u = await record(user.schoolId, 'users', userId);
    if (!u || !['teacher', 'admin'].includes(u.role)) throw new HttpError(404, 'no such member of staff');
    const has = await query('select 1 from accounts where school_id=$1 and user_id=$2', [user.schoolId, userId]);
    if (has.rows.length) throw new HttpError(409, 'they already have a sign-in');
    await query('insert into accounts (school_id, user_id, email, pass_hash) values ($1,$2,$3,$4)', [user.schoolId, userId, email, hashSecret(body.password)]);
    return { userId };
  }
  userId = 'u-' + uid();
  await withTx(async q => {
    await q('insert into accounts (school_id, user_id, email, pass_hash) values ($1,$2,$3,$4)', [user.schoolId, userId, email, hashSecret(body.password)]);
    await putRecord(q, user.schoolId, 'users', userId, { id: userId, name, role, schoolId: user.schoolId }, user.userId);
  });
  return { userId };
}

export async function loginStaff(body, ip) {
  const email = String(body.email || '').trim().toLowerCase();
  throttle('staff:' + ip); throttle('staff:' + email, 8);
  const r = await query('select school_id, user_id, pass_hash from accounts where email=$1', [email]);
  const a = r.rows[0];
  if (!a || !verifySecret(body.password, a.pass_hash)) throw new HttpError(401, 'email or password not recognised');
  return issueToken({ schoolId: a.school_id, userId: a.user_id, role: 'staff' });
}

/* Pupils: the class code first, which lists the names to pick from (names only), then
   the PIN for the chosen name. */
async function classByCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) throw new HttpError(400, 'class code needed');
  const r = await query(`select school_id, doc from records where collection='classes' and not deleted and upper(doc->>'code') = $1 limit 1`, [c]);
  if (!r.rows.length) throw new HttpError(404, 'no class has that code');
  return { schoolId: r.rows[0].school_id, klass: r.rows[0].doc };
}

export async function lookupClass(body, ip) {
  throttle('class:' + ip, 30);
  const { schoolId, klass } = await classByCode(body.code);
  const ids = klass.students || [];
  const r = ids.length
    ? await query(`select doc from records where school_id=$1 and collection='users' and not deleted and key = any($2)`, [schoolId, ids])
    : { rows: [] };
  const pupils = r.rows.map(x => ({ id: x.doc.id, name: x.doc.name })).sort((a, b) => a.name.localeCompare(b.name));
  return { classId: klass.id, className: klass.name, pupils };
}

export async function loginPupil(body, ip) {
  throttle('pupil:' + ip); throttle('pupil:' + body.userId, 8);
  const { schoolId, klass } = await classByCode(body.code);
  if (!(klass.students || []).includes(body.userId)) throw new HttpError(404, 'that pupil is not in this class');
  const r = await query('select pin_hash from pupil_pins where school_id=$1 and user_id=$2', [schoolId, body.userId]);
  if (!r.rows.length) throw new HttpError(403, 'no PIN has been set for this pupil yet — ask your teacher');
  if (!verifySecret(body.pin, r.rows[0].pin_hash)) throw new HttpError(401, 'that PIN is not right');
  return issueToken({ schoolId, userId: body.userId, role: 'student' });
}

/* PUT /pupils/:id/pin — staff set or reset a pupil's PIN. */
export async function setPin(user, pupilId, body) {
  if (user.role !== 'staff') throw new HttpError(403, 'staff only');
  if (!PIN_RE.test(String(body.pin || ''))) throw new HttpError(400, 'PIN must be 4 to 6 digits');
  const pupil = await record(user.schoolId, 'users', pupilId);
  if (!pupil || pupil.role !== 'student') throw new HttpError(404, 'no such pupil in this school');
  await query(`insert into pupil_pins (school_id, user_id, pin_hash) values ($1,$2,$3)
    on conflict (school_id, user_id) do update set pin_hash=excluded.pin_hash, updated_at=now()`,
    [user.schoolId, pupilId, hashSecret(body.pin)]);
  return { ok: true };
}

/* Parents: the code the school printed for their child. First sign-in creates the
   parent's user record so the app has someone to be. */
export async function loginParent(body, ip) {
  throttle('parent:' + ip);
  const code = String(body.code || '').trim().toUpperCase();
  if (!code) throw new HttpError(400, 'parent code needed');
  const r = await query(`select school_id, key from records where collection='parentCodes' and not deleted and upper(doc #>> '{}') = $1 limit 1`, [code]);
  if (!r.rows.length) throw new HttpError(404, 'that parent code is not recognised');
  const { school_id: schoolId, key: childId } = r.rows[0];
  const child = await record(schoolId, 'users', childId);
  if (!child) throw new HttpError(404, 'that parent code is not recognised');
  const existing = await query(`select doc from records where school_id=$1 and collection='users' and not deleted and doc->>'role'='parent' and doc->>'childId'=$2 limit 1`, [schoolId, childId]);
  let userId = existing.rows[0]?.doc.id;
  if (!userId) {
    userId = 'u-' + uid();
    const first = String(child.name || '').split(' ')[0];
    await withTx(q => putRecord(q, schoolId, 'users', userId, { id: userId, name: `${first}'s parent`, role: 'parent', childId, schoolId }, userId));
  }
  return issueToken({ schoolId, userId, role: 'parent', childId });
}

export async function logout(user) {
  await query('delete from sessions where token_hash=$1', [user.tokenHash]);
  return { ok: true };
}

export async function whoami(user) {
  const u = await record(user.schoolId, 'users', user.userId);
  const s = await record(user.schoolId, 'schools', user.schoolId);
  return { userId: user.userId, role: user.role, schoolId: user.schoolId, childId: user.childId, name: u?.name || null, school: s?.name || null };
}

export async function sweepSessions() {
  await query('delete from sessions where expires_at < now()');
}
