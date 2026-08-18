---
covers:
  - 'fix(server,relay,mesh,shared): agents can reach each other, and a failed one says so (DOR-1337)'
---

### Fixed

- Your agents can reach each other by following their own instructions. The address one agent needs to message another was written one way in the instructions and matched another way by the access rules, so an agent that did exactly what it was told got "access denied" — even with the permission switched on. Agents now read the real address straight from the agent list, and a shortened address still gets delivered instead of refused (DOR-1337)
- An agent whose turn crashes no longer looks like an agent with nothing to say. The agent that asked now gets a clear failure, plus whatever partial work came through, instead of an empty answer it had no way to question (DOR-1337)

### Changed

- Agents that are set up to talk to each other now start every turn with the tools for it already in hand, instead of spending part of their time looking them up (DOR-1337)
