---
covers:
  - 'fix(tasks): park files with misplaced schedule permissions (DOR-3840)'
---

### Fixed

- A schedule file with `permissions` in the wrong place now waits and tells you where to move it. Its misplaced value never grants a mode. Agents cannot run the parked schedule; you can try it once without approving it.
