---
covers:
  - "fix(rooms): quote the copy's path in the what-moved sync command (DOR-2411)"
  - "fix(rooms): name the operator by their own name in an agent's room context, never 'You' (DOR-2458)"
---

### Fixed

- Agents in a room now call you by the name you gave DorkOS, or "the operator" if you haven't given one, instead of "You", which an agent could read as itself. This covers the messages an agent reads, who reacted to it, who changed the room's files, and the room history it looks up (DOR-2458).
- The command an agent is given to bring the latest room files into its copy now works when that copy sits under a folder with a space in its name (DOR-2411).
