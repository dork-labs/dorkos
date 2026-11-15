---
covers:
  - 'fix(session): a pause that lands as a queued message starts holds it instead of losing it (DOR-4353)'
  - 'fix(session): a held message reruns only when the agent did nothing at all, and keeps its marks (DOR-4353)'
  - 'fix(session): hooks and memory recall before the first model request do not count as the agent acting (DOR-4353)'
  - "fix(session): the prompt suggestion carried over from the last turn doesn't count as the agent acting (DOR-4353)"
  - 'fix(session): a message rerun after a pause goes to Claude Code under a fresh id (DOR-4353)'
---

### Fixed

- Pausing an agent just as another agent's message starts no longer loses that message. It goes back in line, waits while the agent is paused, and runs once when you resume it. The agent that sent it sees it as waiting, not failed.
