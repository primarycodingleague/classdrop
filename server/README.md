# ClassDrop server

The hosted half of ClassDrop: sign-in, record sync and media storage for a school. One
small Node service, a Postgres database and an object store. No framework, no AI, no
third-party calls.

## What it does

- **Sign-in.** Staff: email + password, plus a code from an authenticator app once they
  turn two-step sign-in on (TOTP, RFC 6238; the DfE cyber security standards ask for
  MFA on every staff cloud account). `POST /auth/staff` answers `{mfa:true, pending}`
  for such an account and `POST /auth/staff/mfa {pending, code}` finishes the sign-in;
  the pending challenge lives five minutes. Staff manage it themselves
  (`/auth/mfa/setup`, `/enable {code}`, `/disable {password}`) and the office can reset a
  colleague who has lost their phone (`DELETE /staff/:id/mfa`). Pupils: class code →
  pick your name → PIN. Parents: the parent code the school already prints. Every
  sign-in returns a bearer token; only its hash is stored. Staff and parent tokens last
  30 days, a pupil's one day, because class iPads are shared (the app also signs a pupil
  out after twenty idle minutes and wipes the device's copy).
- **Sync.** The app keeps working on the device and sends the records it changed
  (`POST /sync/push`); it asks for everything that changed since its last version
  (`GET /sync/pull?since=N`) and gets back only what that person may see. Rules are in
  `src/shapes.js` and are the same table the app carries.
- **Media.** Photos, video and voice notes are uploaded once, addressed by SHA-256, and
  referenced from records as `media:<id>`.
- **Import.** An office account can upload a whole device-local ClassDrop database to
  move a school that trialled on one laptop onto the service.
- **Rights and lifecycle.** `GET /export/pupil/:id` gathers everything held about one
  pupil (subject access requests, leavers' files). `DELETE /pupils/:id` erases a pupil:
  every record about them becomes a tombstone, their PIN, sessions and parent account go;
  safeguarding records are kept on purpose, since statutory retention runs to the pupil's
  25th birthday. `DELETE /schools/me` (office, school name typed to confirm) removes the
  school and its media outright. `GET /access-log` shows the DSL and the office who read
  or exported safeguarding data and when.
- **Housekeeping.** Every six hours the service drops expired sessions, removes media
  objects no live record references any more (an erased pupil's photos, a deleted
  hand-in; objects under an hour old are left in case their record is still on its way
  up), purges tombstones older than ninety days and access-log entries older than
  `ACCESS_LOG_YEARS` (default 6). Erasing a pupil runs the media sweep straight away.

## Run it locally

```
cd server
npm install
npm run dev            # PGlite (Postgres in-process) + media on disk, no setup
```

Then in the app, set `localStorage.classdrop_api = 'http://localhost:8787'` and reload.

```
npm test               # node --test, in-memory PGlite, temp media dir
```

## Environment

| Variable | Meaning |
| --- | --- |
| `PORT` | listen port, default 8787 |
| `DATABASE_URL` | Postgres connection string. Unset → PGlite (`PGLITE_DIR` for a file-backed one) |
| `STORAGE` | `disk` (default), `azure` or `s3` |
| `STORAGE_DIR` | disk storage root, default `./data/media` |
| `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_CONTAINER` | Azure Blob Storage account and container (default `media`) |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` | S3 or any S3-compatible store; credentials via the AWS SDK's usual chain |
| `ALLOWED_ORIGINS` | comma-separated origins allowed to call the API, default `https://classdrop.co.uk` |
| `INVITE_CODES` | comma-separated codes that may create a school (`POST /schools`). Unset → sign-up closed |
| `MAX_SCHOOL_MB` | media storage cap per school, default 5120 |

## Deploying

The service is deliberately portable: any host that runs Node 22, a Postgres database
and an S3-compatible bucket. UK region throughout.

- **Azure (UK South), the chosen platform:** `deploy/azure.sh` pasted into Azure Cloud
  Shell builds the lot — PostgreSQL Flexible Server (B1ms, 35-day backups, Azure-services
  access only), a private storage account (`STORAGE=azure`), and a Linux App Service
  running Node 22 with `/health` as its health check, HTTPS only, TLS 1.2. It prints the
  invite code and the DNS records for `api.classdrop.co.uk`; run it again to redeploy.
  About £30–40 a month.
- **AWS (eu-west-2 London), the alternative:** App Runner or a small ECS/Lightsail
  service; RDS PostgreSQL; S3 bucket with public access blocked (`STORAGE=s3`).

Behind a reverse proxy, forward `X-Forwarded-For` so rate limiting sees real addresses.

## Data protection notes

- Records hold exactly what the app's `db` holds, per school, and nothing else. No
  analytics, no logging of record contents.
- Credentials (password and PIN hashes) live in their own tables and are never part of
  a sync response. New passwords must be ten characters or more and are checked against
  a deny list of the most common choices (NCSC guidance), not complexity rules.
- `access_log` also records staff sign-ins, failed attempts on real accounts (never the
  email typed for an unknown account), and two-step changes, so the office can answer
  "who was in, and when". The app shows it under Features → Data protection and, for
  the DSL, on the Safeguarding page.
- Safeguarding records are only returned to the designated safeguarding lead and the
  member of staff who reported them; pupils and parents never receive them.
- Pupils and parents receive only that child's own work plus the class's shared folder
  (not posts still awaiting moderation), and classmates' point entries stripped to the
  number, so the class board works without saying why a child lost a point.
- Removing a person from the register removes them from the server: a tombstoned
  `users` record deletes their account, PIN and sessions (and any parent session for
  that child), and `authenticate()` refuses a token whose user record is tombstoned
  even if a sessions row survived. A changed parent code signs out whoever used the old
  one; the office issues a new one from the Students page.
- Deleting a school is `delete from records where school_id = …`, the same for
  `accounts`, `pupil_pins`, `sessions`, `media`, plus the media objects under
  `<schoolId>/` in the bucket.
