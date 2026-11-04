---
covers:
  - 'fix(tasks): keep startup and Shape schedules awaiting review'
  - 'fix(tasks): retain schedule origin marks across restart'
---

### Fixed

- Schedules awaiting review stay off after restarting. Shape schedules also wait for review when their file is invalid (DOR-3860, DOR-3861).

- Restarting preserves where a schedule’s words came from, so outside words still need your approval.
