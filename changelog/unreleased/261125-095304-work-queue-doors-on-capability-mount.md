---
covers:
  - 'fix(api): the work queue controls a person uses are served by the capability mount (DOR-4978)'
  - 'fix(api): review round 1 on the work queue controls (DOR-4978)'
---

### Changed

- For scripts that use the DorkOS API: the work queue endpoints have new operation names (`work-queue.view_queue`, `work-queue.add_item` and the rest). They are a person's controls, so a call from an agent, or one that sends an API key or any `Authorization` header, is refused with `person_only`, including the stop on every queue. A folder that isn't a full path is refused without repeating what you typed.
