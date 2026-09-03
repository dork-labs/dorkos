---
covers:
  - 'fix(server,shared): two first boots settle on one secret key (DOR-712)'
---

### Fixed

- Fixed a rare first-start problem where two DorkOS processes opening the same brand-new data folder at once — a server plus a CLI command, or a dev server plus the app — each made their own copy of a secret key and one copy was thrown away. Whatever the discarded key had already locked up (saved connection credentials, signed-in sessions) could never be opened again. Now the first process to create the key wins and everything else uses that one (DOR-712)
