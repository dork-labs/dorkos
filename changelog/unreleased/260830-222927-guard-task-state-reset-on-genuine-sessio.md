---
covers:
  - 'fix(client): guard task-state reset on genuine session change (DOR-1632)'
  - 'fix(client): narrow the task-state empty-response guard to fetch timing (DOR-1632)'
---

### Fixed

- Fixed a bug where a session's task list could lose tasks that had just been created, and stay that way until the list next changed, if the task history finished loading late (DOR-1632)
