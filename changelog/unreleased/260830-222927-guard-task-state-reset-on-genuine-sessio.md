---
covers:
  - 'fix(client): guard task-state reset on genuine session change (DOR-1632)'
---

### Fixed

- Fixed a rare bug where a session's task list could briefly lose tasks that had just been created, if the task history finished loading late (DOR-1632)
