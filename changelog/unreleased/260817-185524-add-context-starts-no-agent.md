---
covers:
  - 'fix(server,client,shared): adding context to a chat no longer starts a warm agent behind the operator (DOR-1307)'
---

### Fixed

- Adding context to a chat no longer quietly starts a second agent. "Add context" was booting a fresh Claude Code process even with the "keep the agent running between messages" setting turned off, and every message after it in that chat stayed on the running agent. Now your words are held and handed to the agent with your next reply, the chat says "Added context for the next reply", and nothing starts up on its own (DOR-1307)
