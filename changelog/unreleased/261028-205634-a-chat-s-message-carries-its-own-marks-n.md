---
covers:
  - "fix(server): a chat's message carries its own marks, not a sibling chat's (DOR-3386)"
---

### Fixed

- An agent's message to another chat is held back only when the chat it came from read something from outside your team. Before, when DorkOS had lost track of the sending chat's level (after a restart, say), any other chat of that agent reading a room post could hold it back, and the chat it woke then asked you to approve its commands. (DOR-3386)
