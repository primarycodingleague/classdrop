# ClassDrop — working notes for Claude

Primary Coding League web product, published at https://classdrop.co.uk via GitHub Pages (CNAME file in repo root).

- `app/index.html` — the whole ClassDrop app, single-file; served at classdrop.co.uk/app (`app.html` is a redirect stub for old links).
- Teacher "Tools" page (page id `tools`, legacy alias `library`): tabs for canvases, visual timetables, shared tasks.
- `index.html` — the public landing page; its CTAs link to `/app/`.
- Local preview: any static server (on the original Mac: launch config "classdrop", port 8641).
- Follow the PCL house style (gold #ae853e on charcoal, Montserrat) for any UI work.
- Verify changes in a browser before calling them done.
- Standing instruction: always commit + push as part of the task.
