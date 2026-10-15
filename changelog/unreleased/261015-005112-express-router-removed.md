---
covers:
  - 'feat(extensions)!: remove the Express router, extensions serve with defineServer (DOR-2861)'
---

### Removed

- DorkOS no longer runs the old Express router for an extension's server part. An extension that still adds routes to it doesn't start, and its card in **Settings > Extensions** says "uses an old server style". Its page, settings and data are untouched. Ask an agent to update it: the change is small, and the agent knows how.
- DorkOS no longer installs Express, so a fresh install is smaller.

### Changed

- A new extension's server part starts with `defineServer`, which DorkOS calls with the extension's context. An older entry that never used its router keeps working.
