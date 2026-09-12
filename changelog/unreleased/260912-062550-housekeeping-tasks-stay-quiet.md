---
covers:
  - "feat(claude-code): pass the runtime's housekeeping flag through on background task events"
  - 'feat(client): keep housekeeping tasks off the task bar until they fail'
---

### Changed

- Background chores your agent runs for itself no longer crowd the task bar. They show in the expanded panel, and any that fail still show up like other failures.
