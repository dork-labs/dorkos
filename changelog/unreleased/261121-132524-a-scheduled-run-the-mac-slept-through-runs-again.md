---
covers:
  - 'fix(tasks): a scheduled run your Mac slept through says so and runs again after it wakes (DOR-3286)'
  - 'fix(tasks): match the sleep line exactly, so a runtime error that opens with its words earns no retry (DOR-3286)'
---

### Fixed

- When your Mac goes to sleep in the middle of a scheduled task and the run breaks as it wakes, its history now says "Interrupted: the computer slept during this run", not a confusing error. The task then runs once more after your Mac has been awake for two minutes, as long as it is still due.
- A sign-in or usage-limit problem is still shown as it is, even if your Mac slept, because running again would not fix it.
- A run broken by sleep no longer counts toward "failed twice in a row".
- A scheduled task that could not start because your Mac was asleep no longer says "Nothing was available to run".
- A task your Mac slept through is no longer marked "Interrupted by server restart" while it is still running after the Mac wakes.
