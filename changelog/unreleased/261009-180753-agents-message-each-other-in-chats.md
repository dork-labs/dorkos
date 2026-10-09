---
covers:
  - 'feat(relay): retire the relay agent send, inbox and endpoint tools (DOR-2790)'
  - 'feat(operating-skills): teach agents to work with spin-off chats (DOR-2790)'
---

### Added

- Agents now message each other in chats you can open, so you can read every handoff between them (DOR-2790)
- See who sent each message: a message from another agent shows that agent and the chat it came from, never you (DOR-2790)
- Spin-off chats report back by themselves when they finish, fail, need you, or pause at a usage limit (DOR-2790)
- A new guide, Spin-off chats, explains when an agent hands work to a chat of its own and how to follow along (DOR-2790)

### Removed

- Agents no longer message each other through Relay's messaging tools. They use chats instead, so nothing between them happens out of sight (DOR-2790)
