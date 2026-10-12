---
covers:
  - 'feat(extensions): an extension can serve its API with a fetch handler (DOR-2810, DOR-2687)'
---

### Added

- Extension authors can now serve an extension's own API with a fetch handler: a function that takes a standard web request and returns a response. Any handler of that shape, such as a Hono app, works as it is. It runs inside DorkOS on Node, so code that needs Bun or Deno's own features does not. The Express router still works, and both can be used together.
