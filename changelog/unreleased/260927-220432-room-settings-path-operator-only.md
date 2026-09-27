---
covers:
  - "fix(rooms): show a room's settings path and fix command only to the person who runs DorkOS (DOR-2457)"
---

### Security

- When a room's git settings could make git run a program, only the person who runs DorkOS now sees which settings they are, where they live on the computer, and the command that removes them. Everyone else in the room sees that the room's files are paused until those settings are fixed (DOR-2457).

### Fixed

- The command DorkOS gives for removing those settings now names the actual settings instead of a placeholder, so it can be pasted and run as it is (DOR-2457).
