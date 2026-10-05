---
covers:
  - 'fix(claude-code): wake a chat whose agent process ended while its background work still ran'
  - 'fix(claude-code): wake only after a restart, and let a lone shell give way'
---

### Fixed

- If DorkOS restarts while a chat is waiting on background work, the chat gets a short note as its next turn, so the agent knows the work stopped and can carry on.
