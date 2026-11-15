---
covers:
  - "fix(runtimes): Dork's chat id goes through the turn allow-list, and an OpenCode lookup failure leaves it unset"
---

### Fixed

- If OpenCode can't look up which chat a command belongs to, the command still runs, just without `DORKOS_SESSION_ID`, instead of failing (DOR-4380).
