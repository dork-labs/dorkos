---
covers:
  - 'fix(rooms): name the operator by name in room listings, notices and canvas lines, not only the context (DOR-2458)'
  - "fix(rooms): quote the copy's path in the what-moved sync command (DOR-2411)"
  - "fix(rooms): name the operator by their own name in an agent's room context, never 'You' (DOR-2458)"
---

### Fixed

- Agents in a room now call you by the name you gave DorkOS, or "the operator" if you haven't given one, instead of "You", which an agent could read as itself. This covers the messages an agent reads, who reacted to it, who changed the room's files, who is in the room, what is on its canvas, and the room history it looks up. The lines a room writes about you, like "Dorian stopped Bo" or who opened a discussion on the canvas, now use that name too, in your own window as well (DOR-2458).
- The command an agent is given to bring the latest room files into its copy now works when that copy sits under a folder with a space in its name (DOR-2411).
