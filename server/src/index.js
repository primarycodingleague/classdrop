/* ClassDrop sync server. Plain Node http — no framework — because the whole API is a
   dozen routes and every dependency is one more thing to explain in a DPIA. */
import http from 'node:http';
import { initDB, closeDB } from './db.js';
import { makeStorage } from './storage.js';
import * as auth from './auth.js';
import * as sync from './sync.js';
import { mediaRoutes } from './media.js';
import { HttpError, readJSON } from './util.js';

export async function createApp(env = process.env) {
  await initDB({ url: env.DATABASE_URL, pgliteDir: env.PGLITE_DIR });
  const storage = makeStorage(env);
  const media = mediaRoutes(storage);
  const origins = (env.ALLOWED_ORIGINS || 'https://classdrop.co.uk').split(',').map(s => s.trim()).filter(Boolean);

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';

    // CORS: the app on classdrop.co.uk (and a local dev server) talks to this origin
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (m === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (m === 'GET' && p === '/health') return send(res, 200, { ok: true, storage: storage.kind });

    // --- sign-in, no token needed ---
    if (m === 'POST' && p === '/schools') return send(res, 201, await auth.createSchool(await readJSON(req), env));
    if (m === 'POST' && p === '/auth/staff') return send(res, 200, await auth.loginStaff(await readJSON(req), ip));
    if (m === 'POST' && p === '/auth/class') return send(res, 200, await auth.lookupClass(await readJSON(req), ip));
    if (m === 'POST' && p === '/auth/pupil') return send(res, 200, await auth.loginPupil(await readJSON(req), ip));
    if (m === 'POST' && p === '/auth/parent') return send(res, 200, await auth.loginParent(await readJSON(req), ip));

    // --- everything below needs a bearer token ---
    const user = await auth.authenticate(req);
    if (m === 'GET' && p === '/me') return send(res, 200, await auth.whoami(user));
    if (m === 'POST' && p === '/auth/logout') return send(res, 200, await auth.logout(user));
    if (m === 'POST' && p === '/staff') return send(res, 201, await auth.createStaff(user, await readJSON(req)));
    let mm;
    if (m === 'PUT' && (mm = p.match(/^\/pupils\/([^/]+)\/pin$/))) return send(res, 200, await auth.setPin(user, decodeURIComponent(mm[1]), await readJSON(req)));

    if (m === 'POST' && p === '/sync/push') return send(res, 200, await sync.push(user, await readJSON(req)));
    if (m === 'GET' && p === '/sync/pull') return send(res, 200, await sync.pull(user, url.searchParams.get('since')));
    if (m === 'POST' && p === '/sync/import') return send(res, 200, await sync.importDB(user, await readJSON(req, 200 * 1048576)));

    if (m === 'POST' && p === '/media') return send(res, 201, await media.upload(user, req));
    if (m === 'POST' && p === '/media/exists') return send(res, 200, await media.exists(user, (await readJSON(req)).ids));
    if (m === 'GET' && (mm = p.match(/^\/media\/([a-f0-9]+)$/))) return media.download(user, mm[1], res);

    throw new HttpError(404, 'not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'something went wrong on the server' : e.message });
      else res.end();
    });
  });
  server.keepAliveTimeout = 65000;

  const sweep = setInterval(() => auth.sweepSessions().catch(() => {}), 6 * 3600 * 1000);
  sweep.unref();

  return {
    server,
    listen: port => new Promise(r => server.listen(port, () => r(server.address().port))),
    close: async () => { clearInterval(sweep); await new Promise(r => server.close(r)); await closeDB(); },
  };
}

if (process.argv[1] && process.argv[1].endsWith('index.js') && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const app = await createApp();
  const port = await app.listen(Number(process.env.PORT) || 8787);
  console.log(`classdrop server listening on :${port}`);
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
