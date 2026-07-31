---
covers:
  - 'fix(rooms): an agent in a room keeps the conversation it is having (DOR-784)'
  - 'docs(rooms): review round — record the record-mode decision and stop overclaiming the startup sweep (DOR-784)'
---

### Fixed

- An agent in a room no longer forgets the conversation. Its replies used to get filed under one name while the room remembered another, so the next message started the agent over from nothing. It happened quietly: no error, no notice, just an agent that had lost the thread. The room now keeps up with the name the moment it changes.
- On startup, DorkOS checks every agent in every room and writes a line in the log for any whose saved conversation it cannot find, naming the room and the agent. Nothing is deleted, so a conversation that went missing can still be tracked down by hand. If DorkOS cannot read your saved conversations at all, it says that too, instead of finishing quietly and looking like all is well.

### Added

- DorkOS now keeps a small record of every turn an agent takes in a room: when it started, what set it off, and how it ended. Rooms are the one place nobody is watching a turn happen, so a turn that failed there used to leave nothing behind to explain it. Nothing in the app reads these records yet. They are there so that when a room goes quiet, there is something to look at.
