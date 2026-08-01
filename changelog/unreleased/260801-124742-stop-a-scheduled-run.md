---
covers:
  - 'fix(tasks): the Stop button reaches a scheduled run wherever it is running (DOR-808)'
  - 'fix(tasks): only the scheduler can stop a run, and a finished run is never filed as stopped (DOR-808)'
  - 'fix(relay): a reserved namespace is refused by the bus, not by each caller (DOR-808)'
---

### Fixed

- **Stopping a scheduled run now works.** On a normal install, DorkOS hands a scheduled run to its message bus, and the Stop button in a task's run history did not know how to reach a run that had gone that way — it answered "run not found" for a run that was plainly still working, and the only way out was to wait or restart. Stop now reaches the run wherever it is running: the agent is told to finish the turn it is on, and the run is recorded as cancelled. (DOR-808)
- **DorkOS no longer claims to have stopped something it could not reach.** If nothing picks up the stop, you are told so in plain words — including when the hold-up is DorkOS's own message limits rather than a silent agent — and the run is left as it is, instead of being marked cancelled while the agent keeps working. Pressing Stop on a run that has already finished says so, and does nothing else. (DOR-808)
- **A run that finished its work is never recorded as one you stopped.** Pressing Stop in the same instant a run was ending filed the finished run as cancelled, output and all. Whichever happened first now wins honestly, on both the scheduled and the direct path. (DOR-808)
- **A scheduled run that hit its time limit is no longer also reported as failed.** The run's own record said "cancelled" while your activity feed said the task failed. Only the run's record was ever right. (DOR-808)
- **Only DorkOS itself can stop your scheduled runs.** Stop requests travel over the same message bus your agents use, and an agent that guessed a run's id could have ended somebody else's work. Anything that is not DorkOS asking on your behalf is now refused. (DOR-808)
- **The names DorkOS reserves for its own messages are now protected everywhere.** Anything reaching your DorkOS port could claim a mailbox at an address DorkOS uses for its own traffic — including agents' own addresses, and the channel that carries a Stop — which quietly intercepted messages meant for someone else. Those addresses are refused now, whoever asks. (DOR-808)

### Changed

- The button on a running job says **Stop**, matching what it does and what DorkOS says back when you press it. (DOR-808)
