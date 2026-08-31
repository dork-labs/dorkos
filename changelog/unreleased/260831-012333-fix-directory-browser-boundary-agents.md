---
covers:
  - 'fix(server): directory browser no longer 403s on the agents folder under a boundary-scoped install (DOR-437)'
---

### Fixed

- The New Agent dialog's directory browser no longer fails to open the agents folder on a
  boundary-scoped install (for example a Docker container with `DORKOS_BOUNDARY` set) (DOR-437).
