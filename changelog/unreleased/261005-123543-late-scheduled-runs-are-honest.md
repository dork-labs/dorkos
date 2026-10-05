---
covers:
  - 'feat(tasks): late scheduled runs say so, and very late ones are skipped (DOR-2718)'
---

### Changed

- Scheduled tasks that ran late now say so, and very late ones are skipped instead of running at odd hours. A run that wakes up under an hour late, and less than halfway to the next scheduled time, still runs. Its history row says how late it was and how many runs were missed while the computer slept (DOR-2718)

### Fixed

- Stop a scheduled task from running twice after the computer wakes, and from being filed under the wrong time (DOR-2718)
