---
covers:
  - 'feat(canvas): stream document updates and native widget actions'
  - 'fix(canvas): reuse retained event rows within each replay page'
---

### Added

- Keep document actions and their delivery status up to date in sessions and rooms.
- Submit native widget actions, retry a lost response without duplicating it, and keep typing while accepted work waits.
