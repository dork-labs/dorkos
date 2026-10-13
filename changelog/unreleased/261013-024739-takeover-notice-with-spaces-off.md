---
covers:
  - 'fix(server): tell a space owner about a takeover request even with spaces switched off (DOR-2760)'
  - 'fix(server): the takeover check reads saved state and asks only for the notice (DOR-2760)'
---

### Fixed

- If someone asks to take over a space you own, DorkOS now tells you even while spaces are switched off. It checks in the background about once an hour.
