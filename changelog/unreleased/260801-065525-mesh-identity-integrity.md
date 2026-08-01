---
covers:
  - 'fix(mesh): an agent keeps its identity when its project is checked out twice (DOR-790)'
  - "fix(rooms): typing a departed agent's name is answered, not swallowed (DOR-790)"
  - 'fix(rooms): only a person naming a departed agent escapes the damping (DOR-790)'
---

### Fixed

- Your agent no longer loses its identity when its project folder is copied or checked out twice. Every copy carries the same agent file, and DorkOS used to hand the agent over to whichever copy it happened to find last — so its `@name` stopped working, it started replying to everything, and its room membership vanished, then came back on the next scan. A copy is now refused, DorkOS says so once, and moving an agent's folder for real still works. (DOR-790)
- Registering a new agent in a folder an old one used to live in no longer gives it the old agent's messages, `@name` and rooms. The new agent starts fresh — including having to be invited back to any rooms, which DorkOS records in its log when it happens. Old messages keep the agent that actually wrote them, forever. (DOR-790)
- An agent that has been removed from your machine stops answering to its `@name`, so a room-mate with the same name is reachable again. Type its name anyway and the room answers every time — it says the agent isn't set up here any more, instead of going quiet. An agent that is merely offline — a closed laptop — keeps its name. (DOR-790)

### Changed

- A folder that already has an agent file is no longer offered as a "new agent" to register. Registering would have overwritten that file with a fresh identity. If the file is damaged, DorkOS names it in the log so you can fix or remove it. (DOR-790)
