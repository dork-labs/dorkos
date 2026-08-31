---
covers:
  - "fix(client): keep a schedule row's timing text fresh after a manual run (DOR-1492)"
---

### Fixed

- Manually running a scheduled task now updates its "last run" and "next
  run" times right away, instead of leaving them stale (DOR-1492)
