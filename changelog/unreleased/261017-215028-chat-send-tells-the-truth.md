---
covers:
  - 'fix(server): chat_send tells the truth about delivery (DOR-2994)'
  - 'fix(server): tell the sender, not the refusing chat, why a message was not delivered (DOR-2994)'
---

### Fixed

- A message one agent sends another chat no longer shows as delivered when that chat could not start, for example because too many chats were open. It now shows as not delivered, with the reason, so the sender knows to send it again (DOR-2994)
- An agent's scheduled beat that its chat could not start is now recorded as "could not start" instead of as a beat that ran (DOR-2994)
- A message still waiting in line is no longer marked as answered just because the other chat sent something unrelated (DOR-2994)
- When too many agent chats are already running, a message is refused with a plain note that nothing was kept and it should be sent again, instead of a note about spin-off chats (DOR-2994)

### Added

- An agent can see where its message stands: a queued message says how many messages are ahead of it, and reading a chat lists your recent messages to it as waiting, delivered, answered or not delivered, with the reason (DOR-2994)
