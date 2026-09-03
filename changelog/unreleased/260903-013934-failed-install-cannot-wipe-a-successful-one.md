---
covers:
  - 'fix(server): a failed install can no longer wipe out a concurrent successful one (DOR-711)'
---

### Fixed

- Installing the same package twice at once is safe: when one install fails, it no longer rolls back over the other one's freshly installed files (DOR-711)
