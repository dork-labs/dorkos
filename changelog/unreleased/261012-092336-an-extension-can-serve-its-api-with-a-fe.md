---
covers:
  - 'feat(extensions): an extension can serve its API with a fetch handler (DOR-2810, DOR-2687)'
---

### Added

- Extension authors can now serve an extension's own API with a fetch handler: a function that takes a standard web request and returns a response. A Hono app, or code written for Bun or Deno, works as it is. The Express router still works, and both can be used together.
