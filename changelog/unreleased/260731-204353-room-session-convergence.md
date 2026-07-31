---
covers:
  - 'fix(rooms): an agent in a room keeps the conversation it is having (DOR-784)'
---

### Fixed

- An agent in a room no longer forgets the conversation. Its replies used to get filed under one name while the room remembered another, so the next message started the agent over from nothing. It happened quietly: no error, no notice, just an agent that had lost the thread. The room now keeps up with the name the moment it changes.
- On startup, DorkOS checks every agent in every room and warns in the log about any whose conversation it cannot find, naming the room and the agent. Nothing is deleted, so a conversation that went missing can still be tracked down.
- When an agent answers in a room, DorkOS now keeps a record of the turn: when it started, what set it off, and how it ended. Rooms are the one place nobody is watching a turn happen, so a turn that failed there used to leave nothing behind to explain it.
