/* How each collection in the app's `db` object maps onto sync records, and who may see
   or change what. The client carries an identical SHAPES table (app/index.html, "cloud
   sync" section) — keep the two in step.

   array  — db[c] is an array of records; `key` names the field that identifies one
   map    — db[c] is an object; each own property is a record (value can be anything)
   Anything not listed (session, *Seeded flags) never leaves the device. */
export const SHAPES = {
  schools:        { kind: 'array', key: 'id' },
  users:          { kind: 'array', key: 'id' },
  classes:        { kind: 'array', key: 'id' },
  assignments:    { kind: 'array', key: 'id' },
  items:          { kind: 'array', key: 'id' },
  points:         { kind: 'array', key: 'id' },
  discussions:    { kind: 'array', key: 'id' },
  notifications:  { kind: 'array', key: 'id' },
  canvases:       { kind: 'array', key: 'id' },
  taskLibrary:    { kind: 'array', key: 'id' },
  timetables:     { kind: 'array', key: 'id' },
  safeguarding:   { kind: 'array', key: 'id' },
  sgUpdates:      { kind: 'array', key: 'id' },
  sgAudit:        { kind: 'array', key: 'id' },
  seating:        { kind: 'array', key: 'id' },
  books:          { kind: 'array', key: 'id' },
  loans:          { kind: 'array', key: 'id' },
  screens:        { kind: 'array', key: 'id' },
  tablesRuns:     { kind: 'array', key: 'id' },
  modLog:         { kind: 'array', key: 'id' },
  tablesSettings: { kind: 'array', key: 'classId' },
  tablesAccess:   { kind: 'array', key: 'studentId' },
  handins:        { kind: 'map' },
  grades:         { kind: 'map' },
  marks:          { kind: 'map' },
  attendance:     { kind: 'map' },
  reading:        { kind: 'map' },
  parentCodes:    { kind: 'map' },
};

/* Sub-arrays that two people can append to at the same time (a teacher and a pupil
   both posting in a discussion). Instead of last-writer-wins on the whole record, the
   server unions these by the entries' ids so nobody's post is silently dropped. */
export const MERGE_ARRAYS = { discussions: ['posts'], items: ['comments'] };

const STAFF = new Set(['teacher', 'admin']);
const isStaffDoc = u => u && STAFF.has(u.role);
const SHARED = '__shared';   // the app's pseudo-pupil id for an assignment's shared folder
const has = (arr, v) => Array.isArray(arr) && arr.includes(v);
const keyIsFor = (key, uid) => typeof key === 'string' && key.endsWith('_' + uid);

/* Context a pull is evaluated against: built once per request from the school's
   classes/assignments/users/safeguarding records. */
export function buildScope(user, all) {
  const byC = c => all.filter(r => r.collection === c && !r.deleted).map(r => r.doc);
  const school = byC('schools')[0] || {};
  const classes = byC('classes');
  const subject = user.role === 'parent' ? user.childId : user.userId;
  const staff = user.role === 'staff';
  const classIds = staff
    ? classes.map(c => c.id)
    : classes.filter(c => has(c.students, subject)).map(c => c.id);
  const assignmentIds = byC('assignments').filter(a => classIds.includes(a.classId)).map(a => a.id);
  const isDsl = staff && school.dslId === user.userId;
  const incidentIds = staff
    ? byC('safeguarding').filter(i => isDsl || i.reporterId === user.userId).map(i => i.id)
    : [];
  const classmates = new Set();
  if (!staff) classes.filter(c => classIds.includes(c.id)).forEach(c => (c.students || []).forEach(s => classmates.add(s)));
  return { staff, subject, classIds, assignmentIds, isDsl, incidentIds, classmates };
}

export function scopeHash(scope) {
  return [scope.subject, scope.isDsl ? 'dsl' : '', ...scope.classIds.slice().sort()].join('|');
}

/* May this user receive this record? */
export function visible(user, scope, c, key, doc) {
  if (!doc) return true; // tombstones are safe to share: they carry no data
  if (scope.staff) {
    if (c === 'safeguarding') return scope.isDsl || doc.reporterId === user.userId;
    if (c === 'sgUpdates') return scope.isDsl || scope.incidentIds.includes(doc.incidentId);
    if (c === 'sgAudit') return scope.isDsl;
    return true;
  }
  const uid = scope.subject;
  switch (c) {
    case 'schools': return true;
    case 'users': return doc.id === uid || doc.id === user.userId || isStaffDoc(doc) || scope.classmates.has(doc.id);
    case 'classes': return scope.classIds.includes(key);
    case 'assignments': return scope.classIds.includes(doc.classId);
    // a pupil's work is theirs: classmates and their parents see only the shared folder
    // (and not posts still waiting for the teacher's moderation, unless they wrote them)
    case 'items': return scope.assignmentIds.includes(doc.assignmentId)
      && (doc.studentId === uid || (doc.studentId === SHARED && (!doc.pending || doc.authorId === uid)));
    case 'points': case 'discussions': return scope.classIds.includes(doc.classId);
    case 'notifications': return doc.userId === user.userId || doc.userId === uid;
    case 'timetables': return (doc.classIds || []).some(id => scope.classIds.includes(id));
    case 'books': return true;
    case 'loans': case 'tablesRuns': return doc.studentId === uid;
    case 'tablesSettings': return scope.classIds.includes(key);
    case 'tablesAccess': case 'attendance': case 'reading': return key === uid;
    case 'handins': case 'grades': case 'marks': return keyIsFor(key, uid);
    default: return false; // canvases, taskLibrary, safeguarding*, seating, screens, modLog, parentCodes
  }
}

/* What a non-staff user receives of a record they may see. The class points board needs
   every classmate's totals, not why each point was given: another child's point entries
   go out without their behaviour label, emoji or the member of staff who gave them. */
export function redact(user, scope, c, doc) {
  if (scope.staff || !doc) return doc;
  if (c === 'points' && doc.studentId !== scope.subject) {
    return { id: doc.id, classId: doc.classId, studentId: doc.studentId, points: doc.points, ts: doc.ts };
  }
  return doc;
}

/* May this user write (create, change or delete) this record? `existing` is the
   current server copy, if any. */
export function canWrite(user, scope, c, key, doc, existing) {
  if (!(c in SHAPES)) return false;
  if (scope.staff) {
    if (c === 'safeguarding') return scope.isDsl || (doc || existing || {}).reporterId === user.userId;
    if (c === 'sgUpdates') return scope.isDsl || (doc ? scope.incidentIds.includes(doc.incidentId) : true);
    if (c === 'sgAudit') return scope.isDsl || !!doc; // anyone may append to the audit trail, only the DSL may remove
    return true;
  }
  const uid = scope.subject;
  const pupil = user.role === 'student';   // parents read their child's work; they do not do it for them
  const d = doc || existing || {};
  switch (c) {
    case 'items': return pupil && d.authorId === uid && (!existing || existing.authorId === uid);
    case 'discussions': return pupil && !!doc && !!existing && scope.classIds.includes(existing.classId); // posts only, never create/delete
    case 'notifications': return d.userId === user.userId || d.userId === uid;
    case 'reading': return key === uid;
    case 'tablesRuns': return pupil && d.studentId === uid && (!existing || existing.studentId === uid);
    case 'handins': return pupil && keyIsFor(key, uid);
    case 'users': return key === user.userId && !!existing; // own profile only
    default: return false;
  }
}
