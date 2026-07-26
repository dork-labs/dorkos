---
covers:
  - 'fix(client): route internal links through the router instead of the browser (DOR-534)'
---

### Fixed

- Moving between DorkOS pages no longer reloads the whole app. Links that stay inside DorkOS switch pages instantly, so an agent that is mid-answer keeps streaming while you look around (DOR-534)
- Links that belong outside DorkOS — the docs, GitHub, a sign-in page — now reliably open in your browser, including the ones an agent or a connected tool puts in front of you. DorkOS also refuses to open a link that could run code (DOR-534)

### Removed

- Dropped three keyboard shortcuts from the shortcuts panel (⌘1, ⌘2, ⌘3) that were listed but never did anything — the sidebar tabs they pointed at no longer exist (DOR-534)
