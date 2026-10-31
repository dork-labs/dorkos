---
covers:
  - 'fix(server): a scheduled run the Mac slept through is not stopped as over its time limit (DOR-3286)'
---

### Fixed

- A scheduled task's time limit now counts only the time your computer was awake. Before, a run that was a few minutes in when your Mac went to sleep was stopped the moment it woke and marked as having gone past its time limit.
- A task that comes due while your Mac is asleep no longer starts during one of the brief moments it wakes on its own, only to be cut off seconds later. It now waits until the computer has been awake for two minutes, and a run that ends up too late to be useful is marked as skipped because the computer was asleep.
