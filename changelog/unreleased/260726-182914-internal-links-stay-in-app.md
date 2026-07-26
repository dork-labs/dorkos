---
covers:
  - 'fix(client): route internal links through the router instead of the browser (DOR-534)'
---

### Fixed

- DorkOS links now stay in DorkOS. In the desktop app, "Open in New Tab" in the command palette used to hand your own cockpit to Chrome; it now opens a real second DorkOS window, and every other in-app link moves you without reloading the page — so a running agent keeps streaming while you jump around (DOR-534)
- Links that genuinely belong outside — the docs, GitHub, a sign-in page — still open in your normal browser, and links that could run code are refused outright (DOR-534)

### Removed

- Dropped three keyboard shortcuts from the shortcuts panel (⌘1, ⌘2, ⌘3) that were listed but never did anything — the sidebar tabs they pointed at no longer exist (DOR-534)
