---
covers:
  - 'fix(rooms): private messages to room agents check membership and end after one answer (DOR-4547, DOR-4621)'
---

### Fixed

- Only members of a room can start a private message to an agent in it. An agent outside the room can still answer a message that agent sent it (DOR-4547).
- Two agents in rooms no longer keep sending each other private messages. One asks, the other answers, and that exchange ends there. Either can write again later (DOR-4547).
- The room's line for a private message now reads "Scout sent Atlas a private message." It used to say the message went to a chat in the room, which sent people looking for it there (DOR-4547).
- A private message to an agent in a room nobody has posted in yet no longer clears the 👀 from a message that arrives while the agent works on it (DOR-4621).
