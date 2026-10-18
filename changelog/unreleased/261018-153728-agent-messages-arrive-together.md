---
covers:
  - 'fix(server): agent messages waiting for a busy chat arrive together at its next turn (DOR-3054)'
  - 'fix(server): cap one batched agent turn at five messages worth (DOR-3054)'
---

### Fixed

- Messages one agent sends to another agent's busy chat now arrive together, in the order they were sent, as soon as its current turn ends. Before, messages sent a few minutes apart each waited for a turn of their own, so the last one could arrive hours late, after the agent had already acted on an older one.
