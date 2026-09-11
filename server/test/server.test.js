import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/index.js';

let app, base, tmp;
const env = {
  STORAGE: 'disk',
  ALLOWED_ORIGINS: 'https://classdrop.co.uk',
  INVITE_CODES: 'PCL-TEST',
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-media-'));
  env.STORAGE_DIR = tmp;
  app = await createApp(env);
  const port = await app.listen(0);
  base = `http://127.0.0.1:${port}`;
});
after(async () => { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const api = async (method, p, body, token, raw) => {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (raw) { headers['Content-Type'] = raw.mime; payload = raw.bytes; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + p, { method, headers, body: payload });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
};
const push = (token, ops) => api('POST', '/sync/push', { ops }, token);
const pull = (token, since = 0) => api('GET', `/sync/pull?since=${since}`, undefined, token);

let office, teacher, school, classId = 'c-y5', may = 'u-may', leo = 'u-leo';

test('health', async () => {
  const r = await api('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('creating a school needs the invite code and gives the office a token', async () => {
  const bad = await api('POST', '/schools', { invite: 'nope', schoolName: 'X', adminName: 'Y', email: 'a@b.co', password: 'longenoughpw' });
  assert.equal(bad.status, 403);
  const r = await api('POST', '/schools', { invite: 'PCL-TEST', schoolName: 'Brackley Primary', adminName: 'Ms Office', email: 'office@brackley.sch.uk', password: 'correct horse battery' });
  assert.equal(r.status, 201);
  office = r.body;
  school = office.schoolId;
  assert.equal(office.role, 'staff');
  const me = await api('GET', '/me', undefined, office.token);
  assert.equal(me.body.school, 'Brackley Primary');
});

test('staff sign-in works, wrong password does not', async () => {
  const ok = await api('POST', '/auth/staff', { email: 'office@brackley.sch.uk', password: 'correct horse battery' });
  assert.equal(ok.status, 200);
  const bad = await api('POST', '/auth/staff', { email: 'office@brackley.sch.uk', password: 'wrong' });
  assert.equal(bad.status, 401);
});

test('office adds a teacher, teacher signs in', async () => {
  const r = await api('POST', '/staff', { name: 'Miss Taylor', email: 'taylor@brackley.sch.uk', password: 'another long one', role: 'teacher' }, office.token);
  assert.equal(r.status, 201);
  const t = await api('POST', '/auth/staff', { email: 'taylor@brackley.sch.uk', password: 'another long one' });
  assert.equal(t.status, 200);
  teacher = t.body;
  assert.equal(teacher.schoolId, school);
});

test('teacher pushes a class, pupils, an assignment; pull returns them', async () => {
  const r = await push(teacher.token, [
    { c: 'users', k: may, doc: { id: may, name: 'Maya Patel', role: 'student', schoolId: school } },
    { c: 'users', k: leo, doc: { id: leo, name: 'Leo Brown', role: 'student', schoolId: school } },
    { c: 'classes', k: classId, doc: { id: classId, name: 'Year 5', code: 'Y5ABC', teacher: teacher.userId, students: [may, leo], schoolId: school } },
    { c: 'assignments', k: 'a1', doc: { id: 'a1', classId, title: 'Design a game character', createdAt: Date.now() } },
    { c: 'parentCodes', k: may, doc: 'PMAY42' },
    { c: 'handins', k: 'a1_' + leo, doc: { status: 'handed-in', ts: 1 } },
    { c: 'safeguarding', k: 'sg1', doc: { id: 'sg1', studentId: leo, reporterId: teacher.userId, category: 'welfare', schoolId: school } },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = await pull(teacher.token, 0);
  const cs = p.body.records.map(x => x.c + '/' + x.k);
  assert.ok(cs.includes('classes/' + classId));
  assert.ok(cs.includes('safeguarding/sg1'), 'reporter sees their own safeguarding record');
  assert.ok(p.body.version > 0);
});

test('the office (not DSL, not reporter) does not see that safeguarding record; the DSL does', async () => {
  const p = await pull(office.token, 0);
  assert.ok(!p.body.records.some(x => x.c === 'safeguarding'));
  // make the office the DSL
  const s = await push(office.token, [{ c: 'schools', k: school, doc: { id: school, name: 'Brackley Primary', adminId: office.userId, dslId: office.userId, features: {} } }]);
  assert.equal(s.status, 200);
  const p2 = await pull(office.token, 0);
  assert.ok(p2.body.records.some(x => x.c === 'safeguarding' && x.k === 'sg1'));
});

let maya;
test('pupil sign-in: class code lists names, PIN must be set, then works', async () => {
  const list = await api('POST', '/auth/class', { code: 'y5abc' });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.pupils.map(x => x.id).sort(), [leo, may]);
  const noPin = await api('POST', '/auth/pupil', { code: 'Y5ABC', userId: may, pin: '1234' });
  assert.equal(noPin.status, 403);
  const set = await api('PUT', `/pupils/${may}/pin`, { pin: '2468' }, teacher.token);
  assert.equal(set.status, 200);
  const wrong = await api('POST', '/auth/pupil', { code: 'Y5ABC', userId: may, pin: '1111' });
  assert.equal(wrong.status, 401);
  const ok = await api('POST', '/auth/pupil', { code: 'Y5ABC', userId: may, pin: '2468' });
  assert.equal(ok.status, 200);
  maya = ok.body;
  assert.equal(maya.role, 'student');
});

test('pupil pull is scoped: own class and assignment, not another pupil\'s hand-in, never safeguarding or parent codes', async () => {
  const p = await pull(maya.token, 0);
  const keys = p.body.records.map(x => x.c + '/' + x.k);
  assert.ok(keys.includes('classes/' + classId));
  assert.ok(keys.includes('assignments/a1'));
  assert.ok(keys.includes('users/' + leo), 'classmates by name');
  assert.ok(!keys.includes('handins/a1_' + leo), 'not another pupil\'s hand-in');
  assert.ok(!keys.some(k => k.startsWith('safeguarding/')));
  assert.ok(!keys.some(k => k.startsWith('parentCodes/')));
});

test('pupil can hand in her own work but cannot write anyone else\'s, or a class', async () => {
  const ok = await push(maya.token, [{ c: 'items', k: 'it1', doc: { id: 'it1', assignmentId: 'a1', studentId: may, authorId: may, kind: 'text', text: 'My character is a fox', ts: 2 } }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const forged = await push(maya.token, [{ c: 'items', k: 'it2', doc: { id: 'it2', assignmentId: 'a1', studentId: leo, authorId: leo, kind: 'text', text: 'x', ts: 3 } }]);
  assert.equal(forged.status, 200);
  assert.equal(forged.body.results[0].rejected, true);
  assert.equal(forged.body.results[0].current, null, 'nothing to restore: the record never existed');
  const klass = await push(maya.token, [{ c: 'classes', k: classId, doc: { id: classId, name: 'Hacked' } }]);
  assert.equal(klass.body.results[0].rejected, true);
  assert.equal(klass.body.results[0].current.name, 'Year 5', 'the server hands back its own copy so the device can undo');
  const check = await pull(teacher.token, 0);
  assert.equal(check.body.records.find(x => x.c === 'classes' && x.k === classId).doc.name, 'Year 5');
  const t = await pull(teacher.token, 0);
  assert.ok(t.body.records.some(x => x.c === 'items' && x.k === 'it1'), 'teacher receives the hand-in');
});

test('concurrent discussion posts from teacher and pupil are both kept', async () => {
  const d = { id: 'd1', classId, title: 'Our fox stories', authorId: teacher.userId, ts: 10, posts: [{ id: 'p0', by: teacher.userId, text: 'Post your ideas', ts: 10 }] };
  assert.equal((await push(teacher.token, [{ c: 'discussions', k: 'd1', doc: d }])).status, 200);
  // both start from the same copy and append different posts
  const fromTeacher = { ...d, posts: [...d.posts, { id: 'p1', by: teacher.userId, text: 'Great start', ts: 11 }] };
  const fromMaya = { ...d, posts: [...d.posts, { id: 'p2', by: may, text: 'Mine is called Rusty', ts: 12 }] };
  assert.equal((await push(teacher.token, [{ c: 'discussions', k: 'd1', doc: fromTeacher }])).status, 200);
  assert.equal((await push(maya.token, [{ c: 'discussions', k: 'd1', doc: fromMaya }])).status, 200);
  const p = await pull(teacher.token, 0);
  const rec = p.body.records.find(x => x.c === 'discussions' && x.k === 'd1');
  assert.deepEqual(rec.doc.posts.map(x => x.id), ['p0', 'p1', 'p2']);
});

test('deleting a record leaves a tombstone that pulls as null', async () => {
  const v = (await pull(teacher.token, 0)).body.version;
  assert.equal((await push(teacher.token, [{ c: 'handins', k: 'a1_' + leo, doc: null }])).status, 200);
  const p = await pull(teacher.token, v);
  const t = p.body.records.find(x => x.c === 'handins');
  assert.ok(t && t.doc === null);
});

test('media: upload once by hash, fetch back, invisible to another school', async () => {
  const bytes = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;', 'binary');
  const up = await api('POST', '/media', undefined, maya.token, { mime: 'image/gif', bytes });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const id = up.body.id;
  assert.match(id, /^[a-f0-9]{64}$/);
  const again = await api('POST', '/media', undefined, teacher.token, { mime: 'image/gif', bytes });
  assert.equal(again.body.id, id, 'same bytes, same id');
  const ex = await api('POST', '/media/exists', { ids: [id, 'a'.repeat(64)] }, teacher.token);
  assert.deepEqual(ex.body.have, [id]);
  const down = await api('GET', '/media/' + id, undefined, teacher.token);
  assert.equal(down.status, 200);
  assert.equal(down.headers.get('content-type'), 'image/gif');
  assert.ok(Buffer.compare(down.body, bytes) === 0);
  const bad = await api('POST', '/media', undefined, maya.token, { mime: 'text/html', bytes: Buffer.from('<script>') });
  assert.equal(bad.status, 415);
  // a second school cannot fetch it
  const other = await api('POST', '/schools', { invite: 'PCL-TEST', schoolName: 'Elsewhere', adminName: 'A', email: 'a@elsewhere.sch.uk', password: 'a long password' });
  const nope = await api('GET', '/media/' + id, undefined, other.body.token);
  assert.equal(nope.status, 404);
});

test('parent code signs a parent in, scoped to the child, and creates the parent user once', async () => {
  const bad = await api('POST', '/auth/parent', { code: 'ZZZZZZ' });
  assert.equal(bad.status, 404);
  const p1 = await api('POST', '/auth/parent', { code: 'pmay42' });
  assert.equal(p1.status, 200);
  assert.equal(p1.body.childId, may);
  const p2 = await api('POST', '/auth/parent', { code: 'PMAY42' });
  assert.equal(p2.body.userId, p1.body.userId, 'same parent user on the second sign-in');
  const pull1 = await pull(p1.body.token, 0);
  const keys = pull1.body.records.map(x => x.c + '/' + x.k);
  assert.ok(keys.includes('items/it1'), 'sees the child\'s work');
  assert.ok(keys.includes('users/' + p1.body.userId), 'sees own user record');
  assert.ok(!keys.some(k => k.startsWith('safeguarding/')));
  const forge = await push(p1.body.token, [{ c: 'items', k: 'it9', doc: { id: 'it9', assignmentId: 'a1', studentId: may, authorId: may, kind: 'text', text: 'x', ts: 1 } }]);
  assert.equal(forge.body.results[0].rejected, true, 'parents cannot hand in as the child');
  const read = await push(p1.body.token, [{ c: 'reading', k: may, doc: [{ id: 'r1', date: '2026-09-11', book: 'Fantastic Mr Fox', by: p1.body.userId, ts: 1 }] }]);
  assert.equal(read.status, 200, 'parents can add to the reading log');
});

test('scope hash changes when a pupil joins another class, so the app knows to re-pull', async () => {
  const before = (await pull(maya.token, 0)).body.scope;
  assert.equal((await push(teacher.token, [
    { c: 'classes', k: 'c-club', doc: { id: 'c-club', name: 'Robotics Club', code: 'ROBOT1', teacher: teacher.userId, students: [may], schoolId: school } },
  ])).status, 200);
  const after = (await pull(maya.token, 0)).body.scope;
  assert.notEqual(before, after);
});

test('import of a whole device database (office only) lands every collection', async () => {
  const db = {
    schools: [{ id: 'sch-local', name: 'Brackley Primary', adminId: office.userId, features: { tables: false } }],
    users: [{ id: 'u-new', name: 'Poppy Green', role: 'student', schoolId: 'sch-local' }],
    classes: [{ id: 'c-y3', name: 'Year 3', code: 'Y3XYZ', teacher: teacher.userId, students: ['u-new'], schoolId: 'sch-local' }],
    marks: { 'mk1_u-new': { value: 'EXS', ts: 5 } },
    reading: { 'u-new': [{ id: 'r9', book: 'The Twits', ts: 6 }] },
    session: 'u-tay', tablesSeeded: true,
  };
  const denied = await api('POST', '/sync/import', { db }, teacher.token);
  assert.equal(denied.status, 403);
  const r = await api('POST', '/sync/import', { db }, office.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.imported, 5);
  const p = await pull(office.token, 0);
  const sch = p.body.records.find(x => x.c === 'schools');
  assert.equal(sch.k, school, 'the school keeps its server id');
  assert.equal(sch.doc.features.tables, false);
  const u = p.body.records.find(x => x.c === 'users' && x.k === 'u-new');
  assert.equal(u.doc.schoolId, school, 'schoolId rewritten to the server school');
  assert.ok(p.body.records.some(x => x.c === 'reading' && x.k === 'u-new'));
});

test('bad tokens and unknown routes', async () => {
  assert.equal((await api('GET', '/sync/pull?since=0', undefined, 'nonsense')).status, 401);
  assert.equal((await api('GET', '/sync/pull?since=0')).status, 401);
  assert.equal((await api('GET', '/nothing', undefined, teacher.token)).status, 404);
  const big = await push(teacher.token, [{ c: 'nope', k: 'x', doc: {} }]);
  assert.equal(big.status, 400);
});

test('logout revokes the token', async () => {
  const t = await api('POST', '/auth/staff', { email: 'taylor@brackley.sch.uk', password: 'another long one' });
  assert.equal((await api('POST', '/auth/logout', {}, t.body.token)).status, 200);
  assert.equal((await api('GET', '/me', undefined, t.body.token)).status, 401);
});

test('keys that would poison a prototype are refused', async () => {
  const a = await push(teacher.token, [{ c: 'handins', k: '__proto__', doc: { polluted: true } }]);
  assert.equal(a.status, 400);
  const b = await push(teacher.token, [{ c: 'items', k: 'itx', doc: { id: 'itx', assignmentId: 'a1', studentId: may, authorId: may, kind: 'text', text: 'x', ts: 1, nested: JSON.parse('{"__proto__":{"evil":1}}') } }]);
  assert.equal(b.status, 400);
});

test('security headers on every response', async () => {
  const r = await api('GET', '/health');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('subject access export gathers everything about one pupil, logs it, hides safeguarding from non-DSL staff', async () => {
  const t = await api('POST', '/auth/staff', { email: 'taylor@brackley.sch.uk', password: 'another long one' });
  const r = await api('GET', '/export/pupil/' + may, undefined, t.body.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pupil.name, 'Maya Patel');
  assert.ok(r.body.records.items.some(i => i.id === 'it1'));
  assert.ok(r.body.records.reading.some(x => x.key === may));
  assert.ok(r.body.records.discussions.every(d => d.posts.every(p => p.by === may)), 'only her own posts');
  assert.equal(r.body.records.safeguarding, undefined, 'sg1 is about Leo, and Maya has none');
  const missing = await api('GET', '/export/pupil/nobody', undefined, t.body.token);
  assert.equal(missing.status, 404);
  const log = await api('GET', '/access-log', undefined, office.token);
  assert.equal(log.status, 200);
  assert.ok(log.body.entries.some(e => e.kind === 'export-pupil' && e.detail.pupil === may));
  assert.ok(log.body.entries.some(e => e.kind === 'safeguarding-read'), 'earlier pulls that returned safeguarding were logged');
  const denied = await api('GET', '/access-log', undefined, t.body.token);
  assert.equal(denied.status, 403, 'a plain teacher cannot read the access log');
});

test('erasing a pupil tombstones their records, keeps safeguarding, removes their PIN, sessions and parent', async () => {
  const t = await api('POST', '/auth/staff', { email: 'taylor@brackley.sch.uk', password: 'another long one' });
  const denied = await api('DELETE', '/pupils/' + leo, undefined, t.body.token);
  assert.equal(denied.status, 403, 'office only');
  // the import test replaced the school record without a DSL; make the office DSL again
  await push(office.token, [{ c: 'schools', k: school, doc: { id: school, name: 'Brackley Primary', adminId: office.userId, dslId: office.userId, features: {} } }]);
  const before = (await pull(office.token, 0)).body.records;
  assert.ok(before.some(x => x.c === 'safeguarding' && x.k === 'sg1' && x.doc));
  const r = await api('DELETE', '/pupils/' + leo, undefined, office.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.safeguardingKept, true);
  const after = (await pull(office.token, 0)).body.records;
  assert.equal(after.find(x => x.c === 'users' && x.k === leo).doc, null, 'user record is a tombstone');
  assert.ok(after.find(x => x.c === 'safeguarding' && x.k === 'sg1').doc, 'safeguarding record survives');
  const klass = after.find(x => x.c === 'classes' && x.k === classId).doc;
  assert.ok(!klass.students.includes(leo), 'removed from the register');
  const list = await api('POST', '/auth/class', { code: 'Y5ABC' });
  assert.ok(!list.body.pupils.some(p => p.id === leo));
});

test('common and patterned passwords are refused when creating accounts', async () => {
  const weak = ['password123', 'Password123!', '1234567890', 'qwertyuiop', 'aaaaaaaaaa', 'abababababab', 'classdrop2026', 'short'];
  for (const [i, password] of weak.entries()) {
    const r = await api('POST', '/staff', { name: 'Weak', email: `weak${i}@brackley.sch.uk`, password, role: 'teacher' }, office.token);
    assert.equal(r.status, 400, password);
  }
  const ok = await api('POST', '/staff', { name: 'Mr Strong', email: 'strong@brackley.sch.uk', password: 'ottoman bicycle rain', role: 'teacher' }, office.token);
  assert.equal(ok.status, 201);
  const sch = await api('POST', '/schools', { invite: 'PCL-TEST', schoolName: 'Weak Primary', adminName: 'Z', email: 'weakoffice@x.sch.uk', password: 'welcome123' });
  assert.equal(sch.status, 400);
});

test('staff sign-ins, failures and two-step changes appear in the access log (office and DSL only)', async () => {
  await api('POST', '/auth/staff', { email: 'strong@brackley.sch.uk', password: 'nope nope nope' });
  const t = await api('POST', '/auth/staff', { email: 'strong@brackley.sch.uk', password: 'ottoman bicycle rain' });
  assert.equal(t.status, 200);
  const unknown = await api('POST', '/auth/staff', { email: 'nobody@nowhere.sch.uk', password: 'nope nope nope' });
  assert.equal(unknown.status, 401);
  const log = await api('GET', '/access-log', undefined, office.token);
  assert.equal(log.status, 200);
  const mine = log.body.entries.filter(e => e.by === t.body.userId);
  assert.ok(mine.some(e => e.kind === 'staff-signin-failed' && e.detail.step === 'password'), 'failed attempt logged');
  assert.ok(mine.some(e => e.kind === 'staff-signin' && e.detail.mfa === false), 'sign-in logged');
  assert.ok(!JSON.stringify(log.body).includes('nowhere.sch.uk'), 'unknown emails are not kept');
  const denied = await api('GET', '/access-log', undefined, t.body.token);
  assert.equal(denied.status, 403, 'a plain teacher cannot read the log');
});

test('a school can be deleted by the office with its name typed as confirmation, and nothing is left', async () => {
  const other = await api('POST', '/schools', { invite: 'PCL-TEST', schoolName: 'Closing School', adminName: 'A', email: 'a@closing.sch.uk', password: 'a long password' });
  const tok = other.body.token;
  await push(tok, [{ c: 'users', k: 'u-x', doc: { id: 'u-x', name: 'X', role: 'student', schoolId: other.body.schoolId } }]);
  const up = await api('POST', '/media', undefined, tok, { mime: 'image/png', bytes: Buffer.from('not really a png but bytes') });
  assert.equal(up.status, 201);
  const wrong = await api('DELETE', '/schools/me', { confirm: 'Wrong Name' }, tok);
  assert.equal(wrong.status, 400);
  const r = await api('DELETE', '/schools/me', { confirm: 'Closing School' }, tok);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.media, 1);
  assert.equal((await api('GET', '/me', undefined, tok)).status, 401, 'sessions gone');
  const again = await api('POST', '/auth/staff', { email: 'a@closing.sch.uk', password: 'a long password' });
  assert.equal(again.status, 401, 'account gone');
});

test('two-step sign-in: setup, enable with a live code, then login needs the code; office can reset', async () => {
  const { totp } = await import('../src/auth.js');
  const login = await api('POST', '/auth/staff', { email: 'taylor@brackley.sch.uk', password: 'another long one' });
  const tok = login.body.token;
  const setup = await api('POST', '/auth/mfa/setup', {}, tok);
  assert.equal(setup.status, 200);
  assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.body.otpauth, /^otpauth:\/\/totp\/ClassDrop/);
  const bad = await api('POST', '/auth/mfa/enable', { code: '000000' }, tok);
  assert.equal(bad.status, 400);
  const ok = await api('POST', '/auth/mfa/enable', { code: totp(setup.body.secret) }, tok);
  assert.equal(ok.status, 200);
  assert.equal((await api('GET', '/me', undefined, tok)).body.mfa, true);
  // password alone is no longer enough
  const step1 = await api('POST', '/auth/staff', { email: 'taylor@brackley.sch.uk', password: 'another long one' });
  assert.equal(step1.status, 200);
  assert.equal(step1.body.mfa, true);
  assert.ok(step1.body.pending && !step1.body.token);
  const wrong = await api('POST', '/auth/staff/mfa', { pending: step1.body.pending, code: '123456' });
  assert.equal(wrong.status, 401);
  const pendingAsToken = await api('GET', '/me', undefined, step1.body.pending);
  assert.equal(pendingAsToken.status, 401, 'a pending challenge is not a session');
  const step2 = await api('POST', '/auth/staff/mfa', { pending: step1.body.pending, code: totp(setup.body.secret) });
  assert.equal(step2.status, 200, JSON.stringify(step2.body));
  assert.ok(step2.body.token);
  const reused = await api('POST', '/auth/staff/mfa', { pending: step1.body.pending, code: totp(setup.body.secret) });
  assert.equal(reused.status, 401, 'a challenge is single-use');
  // turning it off needs the password; a wrong one is 403, never 401 (401 would sign the device out)
  const offWrong = await api('POST', '/auth/mfa/disable', { password: 'not it' }, step2.body.token);
  assert.equal(offWrong.status, 403);
  assert.equal((await api('GET', '/me', undefined, step2.body.token)).body.mfa, true, 'still on');
  // lost phone: the office resets it
  const denied = await api('DELETE', `/staff/${teacher.userId}/mfa`, undefined, step2.body.token);
  assert.equal(denied.status, 403);
  const reset = await api('DELETE', `/staff/${teacher.userId}/mfa`, undefined, office.token);
  assert.equal(reset.status, 200);
  const plain = await api('POST', '/auth/staff', { email: 'taylor@brackley.sch.uk', password: 'another long one' });
  assert.ok(plain.body.token, 'password alone works again after the reset');
  const log = (await api('GET', '/access-log', undefined, office.token)).body.entries;
  assert.ok(log.some(e => e.kind === 'mfa-on' && e.by === teacher.userId), 'turning it on is logged');
  assert.ok(log.some(e => e.kind === 'mfa-reset' && e.detail.staff === teacher.userId), 'the office reset is logged');
  assert.ok(log.some(e => e.kind === 'staff-signin' && e.detail.mfa === true && e.by === teacher.userId), 'a two-step sign-in is logged as such');
  assert.ok(log.some(e => e.kind === 'staff-signin-failed' && e.detail.step === 'code' && e.by === teacher.userId), 'a wrong code is logged');
});

test('media garbage collection removes objects no live record references', async () => {
  const bytes = Buffer.from('orphan-bytes-' + Date.now());
  const up = await api('POST', '/media', undefined, office.token, { mime: 'image/png', bytes });
  assert.equal(up.status, 201);
  const id = up.body.id;
  // referenced by a record: survives; then the record is deleted: goes (age gate bypassed by backdating)
  await push(office.token, [{ c: 'notifications', k: 'n-media', doc: { id: 'n-media', userId: office.userId, text: 'x', ts: 1, pic: 'media:' + id } }]);
  const { query } = await import('../src/db.js');
  await query(`update media set created_at = now() - interval '2 hours' where id=$1`, [id]);
  let m = await app.maintenance();
  assert.equal((await api('GET', '/media/' + id, undefined, office.token)).status, 200, 'still referenced, still there');
  await push(office.token, [{ c: 'notifications', k: 'n-media', doc: null }]);
  m = await app.maintenance();
  assert.ok(m.media >= 1, 'collected: ' + JSON.stringify(m));
  assert.equal((await api('GET', '/media/' + id, undefined, office.token)).status, 404, 'gone from storage and the table');
});

test('pupil sign-ins last a day (shared iPads); staff and parents a month', async () => {
  const s = await api('POST', '/auth/staff', { email: 'strong@brackley.sch.uk', password: 'ottoman bicycle rain' });
  const staffHours = (new Date(s.body.expires) - Date.now()) / 3600e3;
  assert.ok(staffHours > 29 * 24 && staffHours <= 30 * 24, 'staff ~30 days');
  await api('PUT', `/pupils/${may}/pin`, { pin: '1357' }, office.token);
  const p = await api('POST', '/auth/pupil', { code: 'Y5ABC', userId: may, pin: '1357' });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const pupilHours = (new Date(p.body.expires) - Date.now()) / 3600e3;
  assert.ok(pupilHours > 23 && pupilHours <= 24, 'pupil ~24 hours, got ' + pupilHours);
});

test('maintenance purges access-log entries older than the retention period', async () => {
  const { query } = await import('../src/db.js');
  await query(`insert into access_log (school_id, user_id, kind, detail, at) values ($1,$2,'export-pupil','{}', now() - interval '7 years')`, [school, office.userId]);
  await query(`insert into access_log (school_id, user_id, kind, detail, at) values ($1,$2,'export-pupil','{}', now() - interval '5 years')`, [school, office.userId]);
  const before = (await query('select count(*)::int as n from access_log where school_id=$1', [school])).rows[0].n;
  const r = await app.maintenance();
  assert.equal(r.log, 1, 'exactly the seven-year-old entry goes');
  const after = (await query('select count(*)::int as n from access_log where school_id=$1', [school])).rows[0].n;
  assert.equal(after, before - 1);
});
