---
covers:
  - 'fix(client): route internal links through the router instead of the browser (DOR-534)'
  - 'fix(client): send confirmed links out of the app, and allowlist link schemes (DOR-534)'
  - 'fix(client): report when a link could not be opened (DOR-534)'
---

### Fixed

- Moving between DorkOS pages no longer reloads the whole app. Links that stay inside DorkOS switch pages instantly, so an agent that is mid-answer keeps streaming while you look around (DOR-534)
- Links that belong outside DorkOS — the docs, GitHub, a sign-in page — now reliably open in your browser, including the ones an agent or a connected tool puts in front of you (DOR-534)
- DorkOS now opens only ordinary web, mail, and file links, and tells you when it turned one down instead of leaving you to guess. A tool that asks you to sign in through a link DorkOS won't open can no longer show you a "Done" button for a sign-in that never happened (DOR-534)

### Removed

- Dropped three keyboard shortcuts from the shortcuts panel (⌘1, ⌘2, ⌘3) that were listed but never did anything — the sidebar tabs they pointed at no longer exist (DOR-534)
