---
covers:
  - 'fix(chat): an agent can read the chats it messaged'
---

### Fixed

- An agent can now read a chat it sent a message to, from any of its own chats, including a scheduled run or a heartbeat. Before, it could only read chats that had written to it first. Your own private chats stay closed to agents.
