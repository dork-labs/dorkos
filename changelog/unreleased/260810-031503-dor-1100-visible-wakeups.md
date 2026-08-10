---
covers:
  - 'fix(server): the busy bar stops lying when an agent wakes up to keep working (DOR-1100)'
---

### Fixed

- The chat no longer goes quiet while your agent is still working. When a background
  task finished, the agent would wake up and carry on — writing, running tools — but
  DorkOS had already decided the turn was over. The screen said idle, the reply
  streamed nowhere, and none of that work was saved to the conversation. DorkOS now
  notices the agent has started talking again, opens a new turn for it, and keeps the
  words and the tool calls where you can see them (DOR-1100)
- The status line now tells you when background tasks are still running after your
  agent has stopped talking, so a session that looks finished but isn't says so
  instead of just going quiet (DOR-1100)
