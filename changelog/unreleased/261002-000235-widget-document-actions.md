---
covers:
  - 'feat(canvas): stream document updates and native widget actions'
  - 'fix(canvas): reuse retained event rows within each replay page'
  - 'perf(server): batch checked document replay page reads'
---

### Added

- Keep document actions and their delivery status up to date in sessions and rooms.
- Submit native widget actions, retry a lost response without duplicating it, and keep typing while accepted work waits.
- Load long document event histories with bounded page reads while preserving authorization and delivery status.
