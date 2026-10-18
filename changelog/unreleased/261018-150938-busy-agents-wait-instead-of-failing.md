---
covers:
  - 'fix(server): a full agent limit waits for a free slot instead of failing the turn (DOR-3012)'
  - 'fix(server): address review of the warm-slot wait (DOR-3012)'
  - 'fix(server): a waiting launch lets a closing process finish, and shutdown waits for it (DOR-3012)'
---

### Fixed

- When every agent on your computer is busy, a new message now waits for one to finish instead of failing. Before, naming several agents in one room post could make each of them say it "ran into a problem". The room and the chat now say the agent is waiting, and it answers as soon as another agent finishes.
- How many agents can run at once now depends on your computer's memory: one per 2 GB, between 12 and 32. A 48 GB machine runs 24 instead of 12. You can set your own number with `runtimes.claudeCode.maxWarmProcesses`.
- If an agent still can't start, the room says why in plain words instead of "ran into a problem".
- Fixed a rare case where an agent that had just started could be shut down before its first reply.
