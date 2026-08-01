---
covers:
  - 'fix(tasks): the Stop button reaches a scheduled run wherever it is running (DOR-808)'
---

### Fixed

- **Stopping a scheduled run now works.** On a normal install, DorkOS hands a scheduled run to its message bus, and the Stop button in a task's run history did not know how to reach a run that had gone that way — it answered "run not found" for a run that was plainly still working, and the only way out was to wait or restart. Stop now reaches the run wherever it is running: the agent is told to finish the turn it is on, and the run is recorded as cancelled. (DOR-808)
- **DorkOS no longer claims to have stopped something it could not reach.** If nothing picks up the stop, you are told that in plain words and the run is left as it is, instead of being marked cancelled while the agent keeps going. Pressing Stop on a run that has already finished says so, and does nothing else. (DOR-808)
- **A scheduled run that hit its time limit is no longer also reported as failed.** The run's own record said "cancelled" while your activity feed said the task failed. Only the run's record was ever right. (DOR-808)
