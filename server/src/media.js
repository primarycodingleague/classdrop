/* Photos, video and voice notes. A record on the wire says "media:<id>" where the app
   held a data: URL; the bytes go here, once, addressed by their SHA-256 so the same
   photo pushed twice is stored once. Anyone signed in to the school may fetch by id:
   ids are 64 hex characters of hash, so they cannot be guessed, and the only way to
   learn one is to receive a record that names it. */
import { query } from './db.js';
import { HttpError, readBody, sha256 } from './util.js';

const MAX_BYTES = 60 * 1048576;   // one recorded video lesson, roughly
const SCHOOL_CAP = (Number(process.env.MAX_SCHOOL_MB) || 5120) * 1048576;   // a school's media, all in
const MIME_OK = /^(image|video|audio)\/[a-z0-9.+-]+$|^application\/pdf$/i;

export function mediaRoutes(storage) {
  const objectKey = (schoolId, id) => `${schoolId}/${id}`;
  return {
    async upload(user, req) {
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
      if (!MIME_OK.test(mime)) throw new HttpError(415, 'only images, video, audio and PDF can be stored as media');
      const bytes = await readBody(req, MAX_BYTES);
      if (!bytes.length) throw new HttpError(400, 'empty upload');
      const id = sha256(bytes);
      const have = await query('select 1 from media where school_id=$1 and id=$2', [user.schoolId, id]);
      if (!have.rows.length) {
        const used = await query('select coalesce(sum(bytes),0) as b from media where school_id=$1', [user.schoolId]);
        if (Number(used.rows[0].b) + bytes.length > SCHOOL_CAP) throw new HttpError(507, 'the school\'s media storage is full — ask the office to make room or raise the limit');
        await storage.put(objectKey(user.schoolId, id), bytes, mime);
        await query('insert into media (school_id, id, mime, bytes, owner_id) values ($1,$2,$3,$4,$5) on conflict do nothing',
          [user.schoolId, id, mime, bytes.length, user.userId]);
      }
      return { id, bytes: bytes.length, mime };
    },
    async exists(user, ids) {
      const list = Array.isArray(ids) ? ids.filter(x => /^[a-f0-9]{64}$/.test(x)).slice(0, 500) : [];
      if (!list.length) return { have: [] };
      const r = await query('select id from media where school_id=$1 and id = any($2)', [user.schoolId, list]);
      return { have: r.rows.map(x => x.id) };
    },
    async download(user, id, res) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new HttpError(404, 'no such media');
      const r = await query('select mime, bytes from media where school_id=$1 and id=$2', [user.schoolId, id]);
      if (!r.rows.length) throw new HttpError(404, 'no such media');
      const bytes = await storage.get(objectKey(user.schoolId, id));
      if (!bytes) throw new HttpError(404, 'no such media');
      res.writeHead(200, {
        'Content-Type': r.rows[0].mime,
        'Content-Length': bytes.length,
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(bytes);
    },
  };
}
