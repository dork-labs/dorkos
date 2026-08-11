---
covers:
  - 'fix(server): the agent stops thinking you refused when a background task interrupts it (DOR-1149)'
  - 'fix(server): key the segment deferral on notifications owed, not tasks running (DOR-1149)'
---

### Fixed

- When a background task finished at an awkward moment, the agent was told its
  own work had been cancelled — in wording that reads like you refusing it. DorkOS
  spotted that and sent a correction, but the correction never landed in the one
  kind of turn where this happens: turns running background tasks. So the agent
  kept believing you had said no, and sometimes told you so. The correction now
  reaches it, and it carries on with the work instead of stopping.
