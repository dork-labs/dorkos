---
covers:
  - 'fix(api): the work queue controls a person uses are served by the capability mount (DOR-4978)'
---

### Changed

- For scripts that use the DorkOS API: the work queue endpoints have new operation names (`workqueue.get`, `workqueue.add_item` and the rest), and an agent that calls one, including the stop on every queue, is now refused with `person_only`. A folder that isn't a full path is refused without repeating what you typed.
