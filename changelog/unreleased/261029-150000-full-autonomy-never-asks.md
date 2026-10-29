---
covers:
  - 'fix(server): an agent set to Full never asks you anything (DOR-3394)'
---

### Fixed

- An agent set to Full autonomy no longer stops to ask you anything, including on scheduled runs and heartbeats, and the Activity feed notes when it sends or changes a setting after reading messages from outside your team. Below Full, a run nobody is watching now stops with a clear reason instead of waiting on a request nobody can answer.
