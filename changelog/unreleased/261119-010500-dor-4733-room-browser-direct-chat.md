---
covers:
  - 'fix(runtimes): room agents learn the Agent browser works only in a direct chat (DOR-4733)'
---

### Fixed

- An agent in a room no longer waits for an Agent browser that can never reach it. Agents are now
  told the Agent browser works only in a direct chat with you, so in a room they say so and ask you
  to continue in a direct chat.
