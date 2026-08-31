---
covers:
  - 'fix(client): restore focus to the control that opened the profile sheet (DOR-1274)'
  - "fix(client): harden DOR-1274's focus restore against stale captures, chain recapture, and the hover-card footer"
---

### Fixed

- Closing a profile now returns keyboard focus to whatever you opened it
  from (a mention, a name, a face) instead of dropping it (DOR-1274)
