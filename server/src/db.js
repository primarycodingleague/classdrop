/* One query() over either a real Postgres (DATABASE_URL) or PGlite, Postgres compiled to
   WebAssembly, which runs in-process with no install — used for local runs and tests so
   the SQL is identical in both places. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

let backend = null;   // { query(text, params), withTx(fn), close() }

export async function initDB({ url = process.env.DATABASE_URL, pgliteDir = process.env.PGLITE_DIR } = {}) {
  if (backend) return backend;
  if (url) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: 8 });
    backend = {
      kind: 'pg',
      query: (text, params) => pool.query(text, params),
      async withTx(fn) {
        const c = await pool.connect();
        try {
          await c.query('begin');
          const out = await fn((t, p) => c.query(t, p));
          await c.query('commit');
          return out;
        } catch (e) { await c.query('rollback').catch(() => {}); throw e; }
        finally { c.release(); }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = pgliteDir ? new PGlite(pgliteDir) : new PGlite();
    await db.waitReady;
    backend = {
      kind: 'pglite',
      query: (text, params) => db.query(text, params),
      withTx: fn => db.transaction(tx => fn((t, p) => tx.query(t, p))),
      close: () => db.close(),
    };
  }
  const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');   // drop comment lines first
  for (const stmt of schema.split(';').map(s => s.trim()).filter(Boolean)) {
    await backend.query(stmt);
  }
  return backend;
}

export const query = (text, params) => backend.query(text, params);
export const withTx = fn => backend.withTx(fn);
export const closeDB = async () => { if (backend) { await backend.close(); backend = null; } };
