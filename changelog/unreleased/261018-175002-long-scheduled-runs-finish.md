---
covers:
  - 'fix(server): scheduled runs longer than two minutes finish instead of failing as never started (DOR-3033)'
  - 'fix(server): a scheduled run retry stands down after a stop, and failure reasons read plainly (DOR-3033)'
  - "fix(server): a scheduled run's retry obeys the schedule as it is now, and Stop ends a run nobody received (DOR-3033)"
---

### Fixed

- Scheduled runs that take longer than two minutes now finish and show their real result. Before, they were marked failed with "the run never started", even though the work went on and often finished.
- When a scheduled run really can't start, it says why: every agent slot was busy, the hourly limit on agent turns was reached, or nothing was there to run it. If nothing was there, it tries once more 30 seconds later.
- A run stopped at its time limit now says how long the limit was.
