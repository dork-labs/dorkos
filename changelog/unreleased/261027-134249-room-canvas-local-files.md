---
covers:
  - "fix(rooms): a picture or PDF an agent puts on a room's canvas shows for everyone"
  - 'fix(rooms): keep shared canvas files named, deduped and size-checked first'
---

### Fixed

- When an agent puts a picture, PDF or other media file from its own folder on a room's canvas, everyone in the room can now see it. Before, the agent was told it worked, but everyone else saw a card instead of the file. DorkOS now copies the file into the room. A file outside the agent's own folders is refused, and the agent is told why.
