---
covers:
  - 'fix(rooms): refuse unreadable room canvas files (DOR-4110)'
---

### Fixed

- An agent can no longer put a file on a room's canvas that the room can't open. It's told to put the text on the canvas or copy the file into the room's files first, so nobody sees an empty card.
