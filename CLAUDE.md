# ClassDrop — working notes for Claude

Primary Coding League web product, published at https://classdrop.co.uk via GitHub Pages (CNAME file in repo root).

- `app/index.html` — the whole ClassDrop app, single-file; served at classdrop.co.uk/app (`app.html` is a redirect stub for old links).
- Teacher "Tools" page (page id `tools`, legacy alias `library`): tabs for canvases, visual timetables, seating plans, shared tasks.
- School feature switches: `school.features[key]` (default on unless explicitly `false`); gate UI with `feat(key)` and keep router guards in step. Add new modules to the `FEATURES` list so the office can switch them.
- Staff can hold two roles: `role` plus `alsoAdmin`/`alsoTeacher`. Use `canTeach()`/`canOffice()` for capability, `isTeacher()`/`isAdmin()` for the currently worn hat (`db.hat`).
- `index.html` — the public landing page; its CTAs link to `/app/`.
- Local preview: any static server (on the original Mac: launch config "classdrop", port 8641).
- Follow the PCL house style (gold #ae853e on charcoal, Montserrat) for any UI work.
- Landing-page parity: whenever a user-facing feature is added or changed in the app, updating the landing page (`index.html` — features grid / copy) is part of the same task and the same PR. The work is not done until the landing page tells the story.
- Verify changes in a browser before calling them done.
- Standing instruction: always commit + push as part of the task.
