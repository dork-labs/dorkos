---
covers:
  - 'feat(client,server): dev servers on this machine show up in the canvas, and a dead port says so (P1, DOR-1259)'
---

### Fixed

- Dev servers you run on your own machine — Vite, Next, anything on a `localhost` address — now show up in the canvas, live reload included. They used to render as a blank white page. Using DorkOS from another device? "localhost" means that device, so the page won't render there yet; the browser toolbar's "Open in system browser" button still gets you to it (DOR-1259).
- The canvas now tells you when a preview goes wrong instead of showing you nothing: when there's no dev server on that address, when a page is taking too long, and when a page failed to load some of its own files (DOR-1259).
