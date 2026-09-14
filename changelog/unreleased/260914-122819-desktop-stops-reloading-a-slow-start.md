---
covers:
  - 'fix(desktop): ignore a heartbeat from the page the watchdog already reloaded (DOR-2034)'
---

### Fixed

- Desktop: a slow start no longer makes the app reload its window over and over, losing unsent messages and half-filled settings each time. The shell was reading the old page's late check-in as the new page coming up, so it kept retrying the same first step instead of trying the deeper fixes (#1840, DOR-2034)
