---
covers:
  - 'fix(server): the busy bar stops lying when an agent wakes up to keep working (DOR-1100)'
  - 'fix(server): address adversarial review — narrow the wake-up signal, retire dead background tasks (DOR-1100)'
  - 'fix(client): address adversarial review — one copy of the reply, one chime, one bounded turn (DOR-1100)'
---

### Fixed

- The chat no longer goes quiet while your agent is still working. When a background
  task finished, the agent would wake up and carry on — writing, running tools — but
  DorkOS had already decided the turn was over. The screen said idle, the reply
  streamed nowhere, and none of that work was saved to the conversation. DorkOS now
  notices the agent has started talking again, picks the conversation back up, and
  keeps the words and the tool calls where you can see them. Your finished reply stays
  on screen while it happens, and you only get one "finished" chime per message you
  send, not one per wake-up (DOR-1100)
- The status line now tells you when background tasks are still running after your
  agent has stopped talking, so a session that looks finished but isn't says so
  instead of just going quiet. The count clears itself when those tasks end — or when
  the agent stops for any reason and they end with it — so it can never sit there
  claiming work that is no longer happening (DOR-1100)
