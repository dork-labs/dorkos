---
covers:
  - 'fix(session): one turn at a time per chat (DOR-1088)'
---

### Fixed

- **A chat now runs one turn at a time.** A message you had queued up could be
  sent while the agent was still working on the previous one, which started a
  second copy of the agent on the same conversation. The two wrote over each
  other, and the box you type in went quiet and unresponsive while replies were
  still coming in. A queued message now simply waits its turn and goes the moment
  the agent finishes.
- Stopping an agent works again in the cases where that second copy had taken
  over. When one of the two finished, it took the controls with it, so Stop had
  nothing left to talk to and the other kept running.
