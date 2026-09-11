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
  assert.equal(forged.status, 403);
  const klass = await push(maya.token, [{ c: 'classes', k: classId, doc: { id: classId, name: 'Hacked' } }]);
  assert.equal(klass.status, 403);
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
  assert.equal(forge.status, 403, 'parents cannot hand in as the child');
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
