---
covers:
  - 'feat(extensions): Hono built in, the caller and requirePerson for fetch handlers, one reply-header rule (DOR-2857)'
  - 'fix(extensions): address review of the fetch-handler work (DOR-2857)'
---

### Added

- An extension's server half can now use Hono with nothing installed. `import { Hono } from 'hono'` used to fail to build for an extension your agent made.
- A fetch handler now knows whether a person sent the request. Put `requirePerson()` in front of a route to keep agents and other websites out of it, or call `checkPerson()` in a handler written without Hono.

### Changed

- A fetch handler's reply can no longer set cookies, run scripts in a page it serves, or redirect to another website. This is the same rule extensions that run in their own process already followed. A redirect to one of its own paths, like `/done`, now lands inside the extension.
