/* Data-subject rights and school lifecycle: a pupil's whole record in one call (subject
   access requests), erasure when a pupil leaves, and deleting a school outright. Every
   read of safeguarding data is written to access_log so the school can show who looked. */
import { query, withTx } from './db.js';
import { SHAPES, buildScope } from './shapes.js';
import { HttpError } from './util.js';

const isOffice = doc => doc && (doc.role === 'admin' || doc.alsoAdmin);

async function meDoc(user) {
  const r = await query(`select doc from records where school_id=$1 and collection='users' and key=$2 and not deleted`, [user.schoolId, user.userId]);
  return r.rows[0]?.doc || null;
}

export async function logAccess(user, kind, detail) {
  await query('insert into access_log (school_id, user_id, kind, detail) values ($1,$2,$3,$4)', [user.schoolId, user.userId, kind, JSON.stringify(detail || {})]);
}

/* Which records are "about" one pupil. Keyed maps use `<something>_<pupilId>` or the
   pupil id itself; array collections name the pupil in a field. */
function aboutPupil(c, key, doc, pid) {
  switch (c) {
    case 'users': return key === pid || (doc && doc.role === 'parent' && doc.childId === pid);
    case 'items': case 'loans': case 'tablesRuns': case 'points': case 'safeguarding': return !!doc && doc.studentId === pid;
    case 'notifications': return !!doc && doc.userId === pid;
    case 'handins': case 'grades': case 'marks': return key.endsWith('_' + pid);
    case 'attendance': case 'reading': case 'tablesAccess': case 'parentCodes': return key === pid;
    case 'discussions': return !!doc && Array.isArray(doc.posts) && doc.posts.some(p => p && p.by === pid);
    default: return false;
  }
}
const mediaRefs = (v, out = new Set()) => {
  if (typeof v === 'string') { const m = v.match(/^media:([a-f0-9]{64})$/); if (m) out.add(m[1]); }
  else if (Array.isArray(v)) v.forEach(x => mediaRefs(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => mediaRefs(x, out));
  return out;
};

/* GET /export/pupil/:id — everything the school holds about one pupil, for a subject
   access request or a leaver's file. Staff only; safeguarding only to the DSL or the
   reporter, as in sync. */
export async function exportPupil(user, pid) {
  if (user.role !== 'staff') throw new HttpError(403, 'staff only');
  const all = await query('select collection, key, doc from records where school_id=$1 and not deleted', [user.schoolId]);
  const pupil = all.rows.find(r => r.collection === 'users' && r.key === pid)?.doc;
  if (!pupil || pupil.role !== 'student') throw new HttpError(404, 'no such pupil');
  const scope = buildScope(user, all.rows.map(r => ({ ...r, deleted: false })));
  const out = {};
  const media = new Set();
  let safeguardingIds = [];
  for (const r of all.rows) {
    if (!aboutPupil(r.collection, r.key, r.doc, pid)) continue;
    if (r.collection === 'safeguarding' && !(scope.isDsl || r.doc.reporterId === user.userId)) continue;
    if (r.collection === 'safeguarding') safeguardingIds.push(r.key);
    if (r.collection === 'discussions') {   // only this pupil's own posts, not the whole thread
      (out.discussions ||= []).push({ id: r.doc.id, title: r.doc.title, posts: r.doc.posts.filter(p => p && p.by === pid) });
      continue;
    }
    (out[r.collection] ||= []).push(SHAPES[r.collection].kind === 'map' ? { key: r.key, value: r.doc } : r.doc);
    mediaRefs(r.doc, media);
  }
  await logAccess(user, 'export-pupil', { pupil: pid, safeguarding: safeguardingIds });
  return { pupil: { id: pid, name: pupil.name }, exportedAt: new Date().toISOString(), exportedBy: user.userId, records: out, media: [...media] };
}

/* DELETE /pupils/:id — erase a pupil (leaver, or a request to be forgotten). Office only.
   Safeguarding records are kept on purpose: statutory retention runs to the pupil's
   25th birthday and the DSL, not the office, decides their fate. Everything else about
   the pupil becomes a tombstone, their PIN and sessions go, and any parent account that
   existed only for them goes too. */
export async function erasePupil(user, pid) {
  if (user.role !== 'staff' || !isOffice(await meDoc(user))) throw new HttpError(403, 'the school office must do this');
  const all = await query('select collection, key, doc from records where school_id=$1 and not deleted', [user.schoolId]);
  const pupil = all.rows.find(r => r.collection === 'users' && r.key === pid)?.doc;
  if (!pupil || pupil.role !== 'student') throw new HttpError(404, 'no such pupil');
  const gone = [];
  const parentIds = [];
  await withTx(async q => {
    for (const r of all.rows) {
      if (!aboutPupil(r.collection, r.key, r.doc, pid) || r.collection === 'safeguarding') continue;
      if (r.collection === 'users' && r.key !== pid) parentIds.push(r.key);
      if (r.collection === 'discussions') {   // strip the pupil's posts, keep the thread
        const doc = { ...r.doc, posts: r.doc.posts.filter(p => !(p && p.by === pid)) };
        await q(`update records set doc=$4, version=nextval('record_version'), updated_at=now(), updated_by=$5 where school_id=$1 and collection=$2 and key=$3`,
          [user.schoolId, r.collection, r.key, JSON.stringify(doc), user.userId]);
        continue;
      }
      await q(`update records set doc=null, deleted=true, version=nextval('record_version'), updated_at=now(), updated_by=$4 where school_id=$1 and collection=$2 and key=$3`,
        [user.schoolId, r.collection, r.key, user.userId]);
      gone.push(r.collection + '/' + r.key);
    }
    // take the pupil out of every class register
    for (const r of all.rows.filter(x => x.collection === 'classes' && Array.isArray(x.doc.students) && x.doc.students.includes(pid))) {
      const doc = { ...r.doc, students: r.doc.students.filter(s => s !== pid) };
      await q(`update records set doc=$4, version=nextval('record_version'), updated_at=now(), updated_by=$5 where school_id=$1 and collection=$2 and key=$3`,
        [user.schoolId, 'classes', r.key, JSON.stringify(doc), user.userId]);
    }
    await q('delete from pupil_pins where school_id=$1 and user_id=$2', [user.schoolId, pid]);
    await q('delete from sessions where school_id=$1 and (user_id=$2 or child_id=$2 or user_id = any($3))', [user.schoolId, pid, parentIds]);
  });
  await logAccess(user, 'erase-pupil', { pupil: pid, records: gone.length, parents: parentIds.length, safeguardingKept: true });
  return { erased: gone.length, parentsRemoved: parentIds.length, safeguardingKept: true };
}

/* DELETE /schools/me  { confirm: "<school name>" } — the whole school, including media
   objects. Office only. No undo. */
export async function deleteSchool(user, body, storage) {
  if (user.role !== 'staff' || !isOffice(await meDoc(user))) throw new HttpError(403, 'the school office must do this');
  const s = await query('select name from schools_meta where id=$1', [user.schoolId]);
  const name = s.rows[0]?.name;
  if (!name || String(body.confirm || '').trim() !== name) throw new HttpError(400, 'type the school\'s name exactly to confirm');
  const media = await query('select id from media where school_id=$1', [user.schoolId]);
  for (const m of media.rows) { try { await storage.remove(`${user.schoolId}/${m.id}`); } catch (e) { /* best effort; the row goes regardless */ } }
  await withTx(async q => {
    for (const t of ['records', 'media', 'sessions', 'pupil_pins', 'accounts', 'access_log', 'schools_meta']) {
      await q(`delete from ${t} where ${t === 'schools_meta' ? 'id' : 'school_id'}=$1`, [user.schoolId]);
    }
  });
  return { deleted: name, media: media.rows.length };
}

/* GET /access-log — the DSL and the office can see who read safeguarding data. */
export async function accessLog(user) {
  if (user.role !== 'staff') throw new HttpError(403, 'staff only');
  const me = await meDoc(user);
  const sch = await query(`select doc from records where school_id=$1 and collection='schools' and key=$1`, [user.schoolId]);
  const isDsl = sch.rows[0]?.doc?.dslId === user.userId;
  if (!isDsl && !isOffice(me)) throw new HttpError(403, 'the DSL or the office only');
  const r = await query('select user_id, kind, detail, at from access_log where school_id=$1 order by at desc limit 500', [user.schoolId]);
  return { entries: r.rows.map(x => ({ by: x.user_id, kind: x.kind, detail: x.detail, at: x.at })) };
}
