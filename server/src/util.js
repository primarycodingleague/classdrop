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

export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
