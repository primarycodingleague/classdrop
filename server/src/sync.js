/* Record sync. The client keeps a working copy of its school's data and sends the
   records it changed (push); the server hands back everything that changed since the
   client's last version (pull), filtered to what that person may see. */
import { query, withTx } from './db.js';
import { SHAPES, MERGE_ARRAYS, buildScope, scopeHash, visible, canWrite } from './shapes.js';
import { HttpError, badKey, hasBadKeys } from './util.js';

const MAX_DOC = 1024 * 1024;       // 1 MB per record on the wire (media is separate)
const MAX_OPS = 2000;
const SCOPE_COLLECTIONS = ['schools', 'classes', 'assignments', 'safeguarding'];

async function loadScope(user) {
  const r = await query(
    `select collection, key, doc, deleted from records where school_id=$1 and collection = any($2)`,
    [user.schoolId, SCOPE_COLLECTIONS]);
  return buildScope(user, r.rows);
}

function mergeArrays(c, incoming, existing) {
  const fields = MERGE_ARRAYS[c];
  if (!fields || !existing || !incoming) return incoming;
  const out = { ...incoming };
  for (const f of fields) {
    const a = Array.isArray(existing[f]) ? existing[f] : [];
    const b = Array.isArray(incoming[f]) ? incoming[f] : [];
    if (!a.length) continue;
    const seen = new Set(b.map(x => x && x.id).filter(Boolean));
    const missing = a.filter(x => x && x.id && !seen.has(x.id));
    if (missing.length) out[f] = b.concat(missing).sort((x, y) => (x.ts || 0) - (y.ts || 0));
  }
  return out;
}

/* A removed person is removed from the server too, not just from the register: their
   account, PIN and every session (and, for a pupil, any parent signed in for them). A
   tombstoned users record is also refused by authenticate(), so a token that slipped
   through would still be useless. */
async function revokeUser(q, schoolId, userId) {
  await q('delete from sessions where school_id=$1 and (user_id=$2 or child_id=$2)', [schoolId, userId]);
  await q('delete from accounts where school_id=$1 and user_id=$2', [schoolId, userId]);
  await q('delete from pupil_pins where school_id=$1 and user_id=$2', [schoolId, userId]);
}

/* POST /sync/push  { ops: [{ c, k, doc }] }   doc === null deletes */
export async function push(user, body) {
  const ops = Array.isArray(body.ops) ? body.ops : null;
  if (!ops) throw new HttpError(400, 'ops must be an array');
  if (ops.length > MAX_OPS) throw new HttpError(413, `too many changes in one push (max ${MAX_OPS})`);
  const scope = await loadScope(user);
  const results = [];
  await withTx(async q => {
    for (const op of ops) {
      const c = String(op.c || ''), k = String(op.k || '');
      if (!(c in SHAPES)) throw new HttpError(400, `unknown collection "${c}"`);
      if (!k || k.length > 200 || badKey(k)) throw new HttpError(400, `bad key for ${c}`);
      const doc = op.doc === null || op.doc === undefined ? null : op.doc;
      if (doc !== null && hasBadKeys(doc)) throw new HttpError(400, `${c}/${k} contains a forbidden key`);
      const json = doc === null ? null : JSON.stringify(doc);
      if (json && json.length > MAX_DOC) throw new HttpError(413, `${c}/${k} is too large — attach photos and videos as media, not inline`);
      const cur = await q('select doc, deleted from records where school_id=$1 and collection=$2 and key=$3', [user.schoolId, c, k]);
      const existing = cur.rows[0] && !cur.rows[0].deleted ? cur.rows[0].doc : null;
      if (!canWrite(user, scope, c, k, doc, existing)) { results.push({ c, k, rejected: true, current: existing }); continue; }
      if (doc === null) {
        if (!cur.rows.length) { results.push({ c, k, version: null }); continue; }
        const r = await q(`update records set doc=null, deleted=true, version=nextval('record_version'), updated_at=now(), updated_by=$4
                           where school_id=$1 and collection=$2 and key=$3 returning version`, [user.schoolId, c, k, user.userId]);
        if (c === 'users' && existing) await revokeUser(q, user.schoolId, k);
        results.push({ c, k, version: Number(r.rows[0].version) });
      } else {
        // a new parent code means the old one has leaked or the family has changed: whoever
        // signed in with the old one is out
        if (c === 'parentCodes' && existing && existing !== doc) await q(`delete from sessions where school_id=$1 and role='parent' and child_id=$2`, [user.schoolId, k]);
        const merged = mergeArrays(c, doc, existing);
        const r = await q(`insert into records (school_id, collection, key, doc, deleted, version, updated_by)
                           values ($1,$2,$3,$4,false,nextval('record_version'),$5)
                           on conflict (school_id, collection, key) do update set doc=excluded.doc, deleted=false,
                           version=nextval('record_version'), updated_at=now(), updated_by=excluded.updated_by
                           returning version`, [user.schoolId, c, k, JSON.stringify(merged), user.userId]);
        results.push({ c, k, version: Number(r.rows[0].version) });
      }
    }
  });
  const v = await query('select coalesce(max(version),0) as v from records where school_id=$1', [user.schoolId]);
  return { version: Number(v.rows[0].v), results };
}

/* GET /sync/pull?since=N */
export async function pull(user, since) {
  const from = Number.isFinite(+since) && +since >= 0 ? Math.floor(+since) : 0;
  const scope = await loadScope(user);
  const r = await query(
    `select collection, key, doc, deleted, version from records where school_id=$1 and version > $2 order by version asc`,
    [user.schoolId, from]);
  const records = [];
  let version = from;
  const sensitive = [];
  for (const row of r.rows) {
    version = Number(row.version);
    if (!visible(user, scope, row.collection, row.key, row.doc)) continue;
    if (!row.deleted && (row.collection === 'safeguarding' || row.collection === 'sgUpdates')) sensitive.push(row.collection + '/' + row.key);
    records.push({ c: row.collection, k: row.key, doc: row.deleted ? null : row.doc, v: version });
  }
  if (sensitive.length) await query('insert into access_log (school_id, user_id, kind, detail) values ($1,$2,$3,$4)',
    [user.schoolId, user.userId, 'safeguarding-read', JSON.stringify({ records: sensitive })]);
  return { version, scope: scopeHash(scope), records };
}

/* POST /sync/import  { db }  — a whole device-local ClassDrop database, written as
   records. Office accounts only; this is how a school that trialled on one laptop moves
   its data onto the service. Records already on the server are replaced. */
export async function importDB(user, body) {
  if (user.role !== 'staff') throw new HttpError(403, 'staff only');
  const me = await query(`select doc from records where school_id=$1 and collection='users' and key=$2`, [user.schoolId, user.userId]);
  const role = me.rows[0]?.doc?.role;
  if (role !== 'admin' && !me.rows[0]?.doc?.alsoAdmin) throw new HttpError(403, 'the school office account must do the import');
  const db = body.db;
  if (!db || typeof db !== 'object') throw new HttpError(400, 'db missing');
  let n = 0;
  await withTx(async q => {
    for (const [c, shape] of Object.entries(SHAPES)) {
      const v = db[c];
      const entries = shape.kind === 'array'
        ? (Array.isArray(v) ? v.map(rec => [rec && rec[shape.key], rec]) : [])
        : (v && typeof v === 'object' ? Object.entries(v) : []);
      for (const [k, doc] of entries) {
        if (k === undefined || k === null || doc === undefined || badKey(k) || hasBadKeys(doc)) continue;
        let d = doc;
        // the imported school keeps its own id: point every record at this school
        if (c === 'schools') d = { ...doc, id: user.schoolId };
        else if (doc && typeof doc === 'object' && 'schoolId' in doc) d = { ...doc, schoolId: user.schoolId };
        const key = c === 'schools' ? user.schoolId : String(k);
        await q(`insert into records (school_id, collection, key, doc, deleted, version, updated_by)
                 values ($1,$2,$3,$4,false,nextval('record_version'),$5)
                 on conflict (school_id, collection, key) do update set doc=excluded.doc, deleted=false,
                 version=nextval('record_version'), updated_at=now(), updated_by=excluded.updated_by`,
          [user.schoolId, c, key, JSON.stringify(d), user.userId]);
        n++;
      }
    }
  });
  const v = await query('select coalesce(max(version),0) as v from records where school_id=$1', [user.schoolId]);
  return { imported: n, version: Number(v.rows[0].v) };
}
