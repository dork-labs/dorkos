---
covers:
  - 'fix(tasks): preserve missing-file caps and simplify faulty review actions (DOR-3840)'
  - 'fix(tasks): keep trial permissions beside the review action (DOR-3840)'
  - 'fix(tasks): close misplaced schedule mode approval gaps (DOR-3840)'
  - 'fix(tasks): park files with misplaced schedule permissions (DOR-3840)'
---

### Fixed

- A schedule file with `permissions` in the wrong place now waits and tells you where to move it. Its misplaced value never grants a mode. Agents cannot run the parked schedule; you can try it once without approving it.
