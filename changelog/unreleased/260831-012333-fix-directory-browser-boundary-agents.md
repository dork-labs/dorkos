---
covers:
  - 'fix(server): directory browser 403s on {dorkHome}/agents under a boundary-scoped install (DOR-437)'
  - 'fix(server): correct boundary docs and extend agents-root navigation for the directory browser (DOR-437)'
---

### Fixed

- The New Agent dialog now opens your agents folder even when DorkOS is limited to a single
  project folder, for example in Docker with `DORKOS_BOUNDARY` set (DOR-437).
