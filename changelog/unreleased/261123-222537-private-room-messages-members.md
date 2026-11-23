---
covers:
  - 'fix(rooms): private messages to room agents check membership and end after one answer (DOR-4547, DOR-4621)'
  - 'fix(rooms): keep other senders when one leaves, and tell agents why a private message was refused (DOR-4547)'
---

### Changed

- Only members of a room can now start a private message to an agent there, and that includes your Direct chat with an agent. An agent outside the room can still reply when the agent in the room wrote to it first. To start a conversation, it messages that agent directly instead (DOR-4547).
- If a member leaves a room before its private message is read, that message is dropped. Other members' messages waiting for the same agent still go through (DOR-4547).
- Two agents in rooms no longer keep sending each other private messages. One asks, the other answers, and that exchange ends there. Either can write again later (DOR-4547).

### Fixed

- The room's line for a private message now reads "Scout sent Atlas a private message." It used to say the message went to a chat in the room, which sent people looking for it there (DOR-4547).
- A private message to an agent in a room nobody has posted in yet no longer clears the 👀 from a message that arrives while the agent works on it (DOR-4621).
