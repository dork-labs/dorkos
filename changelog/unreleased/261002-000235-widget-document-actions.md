---
covers:
  - 'feat(canvas): emit native widget actions with durable status'
  - 'fix(canvas): preserve uncertain widget submission identity'
---

### Added

- Save native document actions with separate status for saving, agent work, and reported handling. Retry a lost response without creating another action, and keep typing while accepted work waits.
