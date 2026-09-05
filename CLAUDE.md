# ClassDrop — working notes for Claude

Primary Coding League web product, published at https://classdrop.co.uk via GitHub Pages (CNAME file in repo root).

- `app/index.html` — the whole ClassDrop app, single-file; served at classdrop.co.uk/app (`app.html` is a redirect stub for old links).
- Teacher "Tools" page (page id `tools`, legacy alias `library`): tabs for class screen (the default), canvases, visual timetables, seating plans, shared tasks.
- Reading corner (code prefixed `rc`, gated by `feat('reading')`): a shared-device kiosk with no pupil logins, launched from a class's Reading tab. School book stock in `db.books` (keyed by ISBN, added once on first scan), loans in `db.loans`. A finished loan also writes a `db.reading` entry via `rcLogEntry` so the log and the loans never drift. A USB barcode scanner is only a fast keyboard ending in Enter — no driver, and typing the ISBN works the same.
- Class screen (feature key `classscreen`, code prefixed `cs`): a full-screen widget board saved in `db.screens`. Widgets are declared in `CS_WIDGETS`; each gets a `bodyHTML` case and a `wire` case. Anything needing the register reads the real class — the group maker honours keep-apart pairs from that class's seating plans. Live widgets update their own nodes; `paint()` clears every interval in `loops` first.
- School feature switches: `school.features[key]` (default on unless explicitly `false`); gate UI with `feat(key)` and keep router guards in step. Add new modules to the `FEATURES` list so the office can switch them.
- Times tables (feature key `tables`, code prefixed `xt`): teacher class tab + pupil/parent page `tables`. Every answer is stored with its recall time in `db.tablesRuns`; fluency is derived, never stored. Per-class settings live in `db.tablesSettings`.
- Year 4 MTC mock (`s.mtc` per class, code prefixed `mtc`): 25 questions, 6s each, 3s gap, question spread per DfE in `MTC_PLAN` — keep it faithful to the published proportions, and never adapt it to the child. Per-pupil access arrangements in `db.tablesAccess`. Predicted scores are estimates from recall data and must always be shown with their coverage caveat.
- Staff can hold two roles: `role` plus `alsoAdmin`/`alsoTeacher`. Use `canTeach()`/`canOffice()` for capability, `isTeacher()`/`isAdmin()` for the currently worn hat (`db.hat`).
- `index.html` — the public landing page; its CTAs link to `/app/`.
- Local preview: any static server (on the original Mac: launch config "classdrop", port 8641).
- Follow the PCL house style (gold #ae853e on charcoal, Montserrat) for any UI work. Text colours are AA-checked: body text on gold uses `#2b2211`, never white; `--gold-dk`, `--muted`, `--amber`, `--green` are the darkened text-safe values, and the times-tables cell colours have their own set. Re-run axe (scratchpad `a11y-detail.js`) after palette changes.
- Both pages carry a `Content-Security-Policy` meta: the app may only talk to its own origin (plus `data:`/`blob:` for stored media); the landing and privacy pages additionally allow the Cloudflare beacon. Any new external resource will be silently blocked until the policy names it — that is the point.
- Montserrat is served from `/fonts/*.woff2` (not Google Fonts, not base64). Site files at the root: `favicon.svg/.ico`, `icons/`, `manifest.webmanifest` (scoped to `/app/`), `og-image.png`, `robots.txt` (disallows `/app/`), `sitemap.xml`, `404.html`, `.well-known/security.txt`, and the privacy notice at `privacy/index.html`, which mirrors the DPIA supplier pack and must be updated when data handling changes.
- Every app page has one `h1` (the `.page-head` heading); icon-only buttons need an `aria-label`.
- iPad/Safari: no WebKit here, so run the scratchpad `test-ipad.js` sweep (Chromium at iPad sizes) and keep the iOS rules: create/resume `AudioContext` inside a tap, use `100dvh` after `100vh`, and keep media on `blob:` URLs.
- Landing-page parity: whenever a user-facing feature is added or changed in the app, updating the landing page (`index.html` — features grid / copy) is part of the same task and the same PR. The work is not done until the landing page tells the story.
- Verify changes in a browser before calling them done.
- Standing instruction: always commit + push as part of the task.
