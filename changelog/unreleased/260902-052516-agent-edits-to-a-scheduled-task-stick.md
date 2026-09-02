---
covers:
  - "fix(server): an agent's edit to a scheduled task reaches its file (DOR-1625)"
---

### Fixed

- When an agent changed one of your scheduled tasks — its prompt, its schedule,
  its name, or which runtime and model it uses — the change used to disappear
  within five minutes, even though the agent was told it worked. DorkOS wrote
  the change to its own records but never to the task's file, and the file is
  what counts. Agent edits now go into the file first, so they stick (DOR-1625)
