---
covers:
  - 'fix(server): a message to an existing chat waits for a slot instead of being dropped (DOR-3375)'
---

### Fixed

- When the computer is already running its limit of agent chats, a message from one agent to an existing chat now waits and starts when a slot frees. Before, it was dropped and the sender had to try again. The limit still stops brand-new chats from starting.
