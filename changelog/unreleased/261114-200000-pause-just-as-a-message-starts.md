---
covers:
  - 'fix(session): a pause that lands as a queued message starts holds it instead of losing it (DOR-4353)'
---

### Fixed

- Pausing an agent just as another agent's message starts no longer loses that message. It goes back in line, waits while the agent is paused, and runs once when you resume it. The agent that sent it sees it as waiting, not failed.
