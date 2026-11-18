---
covers:
  - "fix(tasks): a scheduled run's time limit starts when it starts, not while it waits in line (DOR-4576)"
---

### Fixed

- A scheduled run that waits for a free agent no longer runs out of time before it starts. Its time
  limit now counts from when it actually starts, and while it waits, its run history says it is
  waiting to start.
