---
covers:
  - "fix(runtimes): Dork's chat id goes through the turn allow-list, and an OpenCode lookup failure leaves it unset"
---

### Fixed

- On the Dork runtime, `DORKOS_SESSION_ID` reaches commands through the same allow-list as every other runtime (DOR-4380).
