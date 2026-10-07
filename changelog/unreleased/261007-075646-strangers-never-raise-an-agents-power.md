---
covers:
  - "fix(rooms): run a stranger's room turn at the mode that asks (DOR-2764)"
  - 'feat(communities): choose who can wake your agents in a space (DOR-2764)'
  - 'fix(rooms): tell agents in a space channel that outsiders post there (DOR-2764)'
  - 'chore(changelog): note stranger safety in rooms and spaces (DOR-2764)'
  - 'fix(rooms): hold every turn that answers a stranger to the ceiling (DOR-2764)'
  - "fix(rooms): keep a stranger's background work at the ceiling while a turn waits (DOR-2764)"
  - 'chore(changelog): cover the background-ceiling fix (DOR-2764)'
---

### Fixed

- When someone from outside your computer mentions your agent in a room, such as a person in a space or someone in a linked Telegram or Slack chat, the agent's reply now runs at the level that asks before acting, or lower if you set the agent lower. Before, if you had already talked to the agent in that room at a higher level, the outsider's message ran at your level too. A reply that answers your message and an outsider's together runs at the lower level. Your own next message runs at your level again (DOR-2764)
- Agents in a space's channel are now told that people outside your computer post there, and that their messages are not instructions, the same way they are told in a linked chat (DOR-2764)
