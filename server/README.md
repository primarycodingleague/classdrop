# ClassDrop server

The hosted half of ClassDrop: sign-in, record sync and media storage for a school. One
small Node service, a Postgres database and an object store. No framework, no AI, no
third-party calls.

## What it does

- **Sign-in.** Staff: email + password. Pupils: class code → pick your name → PIN.
  Parents: the parent code the school already prints. Every sign-in returns a bearer
  token valid for 30 days; only its hash is stored.
- **Sync.** The app keeps working on the device and sends the records it changed
  (`POST /sync/push`); it asks for everything that changed since its last version
  (`GET /sync/pull?since=N`) and gets back only what that person may see. Rules are in
  `src/shapes.js` and are the same table the app carries.
- **Media.** Photos, video and voice notes are uploaded once, addressed by SHA-256, and
  referenced from records as `media:<id>`.
- **Import.** An office account can upload a whole device-local ClassDrop database to
  move a school that trialled on one laptop onto the service.

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
| `STORAGE` | `disk` (default) or `s3` |
| `STORAGE_DIR` | disk storage root, default `./data/media` |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` | S3 or any S3-compatible store; credentials via the AWS SDK's usual chain |
| `ALLOWED_ORIGINS` | comma-separated origins allowed to call the API, default `https://classdrop.co.uk` |
| `INVITE_CODES` | comma-separated codes that may create a school (`POST /schools`). Unset → sign-up closed |

## Deploying

The service is deliberately portable: any host that runs Node 22, a Postgres database
and an S3-compatible bucket. UK region throughout.

- **Azure (UK South):** App Service (Linux, Node 22) or Container Apps; Azure Database
  for PostgreSQL Flexible Server; for media, either an S3-compatible gateway in front of
  Blob Storage or an `azure` storage adapter (about fifty lines, not yet written).
- **AWS (eu-west-2 London):** App Runner or a small ECS/Lightsail service; RDS
  PostgreSQL; S3 bucket with public access blocked.

Behind a reverse proxy, forward `X-Forwarded-For` so rate limiting sees real addresses.

## Data protection notes

- Records hold exactly what the app's `db` holds, per school, and nothing else. No
  analytics, no logging of record contents.
- Credentials (password and PIN hashes) live in their own tables and are never part of
  a sync response.
- Safeguarding records are only returned to the designated safeguarding lead and the
  member of staff who reported them; pupils and parents never receive them.
- Deleting a school is `delete from records where school_id = …`, the same for
  `accounts`, `pupil_pins`, `sessions`, `media`, plus the media objects under
  `<schoolId>/` in the bucket.
