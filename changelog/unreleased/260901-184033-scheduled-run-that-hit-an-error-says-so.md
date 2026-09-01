---
covers:
  - 'fix(server,relay,shared): a scheduled run that hit an error no longer reads as completed (DOR-1658)'
  - "fix(server,relay,shared): decide a run's outcome on what the error was, not which reason arrived (DOR-1658)"
---

### Fixed

- A scheduled run that hit an error now says so. Run history used to mark those runs finished, with a green tick and no explanation, so a task that died overnight on an expired sign-in looked like it had worked. Now the run is marked failed and shows what went wrong, an expired sign-in leads with what to do about it, and the failure reaches your notifications and your daily report like any other. A run that hit a hiccup and carried on still counts as finished, because it was, and so does one where the only thing that failed was a hook script of your own. (DOR-1658)
