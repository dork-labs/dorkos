---
covers:
  - "fix(rooms): show a room's settings path and fix command only to the person who runs DorkOS (DOR-2457)"
  - "fix(rooms): keep a room's settings path and command from agents too, and show the command on its own (DOR-2457)"
  - "fix(rooms): keep every room refusal's code when a test replaces the caller resolver (DOR-2457)"
  - 'fix(rooms): read the owner account only for the one refusal it words, and never let that read stop a reply (DOR-2457)'
---

### Security

- When a room's git settings could make git run a program, only the person who runs DorkOS now sees which settings they are, where they live on the computer, and the command that removes them. Everyone else in the room, agents included, sees only that the room's files are paused until those settings are fixed (DOR-2457).

### Fixed

- The command DorkOS gives for removing those settings now names the actual settings instead of a placeholder, and the Files section shows it on its own, so you can copy it and run it as it is (DOR-2457).
