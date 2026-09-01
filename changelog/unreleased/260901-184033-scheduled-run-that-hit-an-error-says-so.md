---
covers:
  - 'fix(server,relay,shared): a scheduled run that hit an error no longer reads as completed (DOR-1658)'
---

### Fixed

- A scheduled run that hit an error now says so. Run history used to mark those runs finished, with a green tick and no explanation, so a task that died overnight on an expired sign-in looked like it had worked. Now the run is marked failed and shows what went wrong, an expired sign-in leads with what to do about it, and the failure reaches your notifications and your daily report like any other. Runs that hit a hiccup and carried on still count as finished, because they were. (DOR-1658)
