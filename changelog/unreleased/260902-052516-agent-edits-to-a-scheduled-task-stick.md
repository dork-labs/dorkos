---
covers:
  - "fix(server): an agent's edit to a scheduled task reaches its file (DOR-1625)"
  - "fix(server,operating-skills): say when an agent's edit costs a schedule its approval (DOR-1625 review)"
  - 'fix(operating-skills): bump the pack version so the corrected page reaches seeded agents (DOR-1625)'
---

### Fixed

- When an agent changed one of your scheduled tasks — its prompt, its schedule,
  its name, or which runtime and model it uses — the change used to disappear
  within five minutes, even though the agent was told it worked. DorkOS wrote
  the change to its own records but never to the task's file, and the file is
  what counts. Agent edits now go into the file first, so they stick (DOR-1625)
- Because the edit now really lands, one thing follows that is worth knowing:
  when an agent changes what an approved task does — its prompt or its schedule
  — the task pauses and waits for you to approve it again, since you never saw
  this version. Your agent is told this happened and is asked to tell you.
  Changing anything else, including switching a task on or off, leaves your
  approval alone (DOR-1625)
