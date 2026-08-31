---
covers:
  - 'fix(server): directory browser 403s on {dorkHome}/agents under a boundary-scoped install (DOR-437)'
---

### Fixed

- The New Agent dialog's directory browser no longer fails to open the agents folder on a
  boundary-scoped install (for example a Docker container with `DORKOS_BOUNDARY` set) (DOR-437).
