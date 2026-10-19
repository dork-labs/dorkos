---
covers:
  - 'feat(canvas): pages in the canvas browser can send events to their agent (DOR-2665)'
  - 'fix(canvas): only the page DorkOS opened can connect a served frame (DOR-2665)'
  - 'fix(canvas): the boot nonce rides the query, so a redirect never carries it (DOR-2665)'
---

### Added

- Local pages and dev-server previews in the canvas browser can now send events to your agent. When your agent sets this up for a page, a click in that page can start its next turn. A preview reconnects by itself after it reloads. A local page that reloads, or follows a link to another site, stays offline until you press Reload, so no other site can send events in its place (DOR-2665)
