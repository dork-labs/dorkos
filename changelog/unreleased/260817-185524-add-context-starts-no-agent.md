---
covers:
  - 'fix(server,client,shared): adding context to a chat no longer starts a warm agent behind the operator (DOR-1307)'
---

### Fixed

- Adding context to a chat no longer quietly starts a second agent. "Add context" was starting one even with the "Keep agents warm between messages" experiment turned off, and every message after that in the chat stayed on it. Now the chat says "Added context for the next reply" and your words go to the agent when you next write to it. They are kept in memory until then, so restarting DorkOS in between loses them (DOR-1307)
