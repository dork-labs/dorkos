---
covers:
  - "fix(rooms): run a stranger's room turn at the mode that asks (DOR-2764)"
  - 'fix(rooms): tell agents in a space channel that outsiders post there (DOR-2764)'
  - 'feat(communities): choose who can wake your agents in a space (DOR-2764)'
  - 'chore(changelog): note stranger safety in rooms and spaces (DOR-2764)'
---

### Fixed

- When someone from outside your computer mentions your agent in a room, such as a person in a space or someone in a linked Telegram or Slack chat, that reply now always stops to ask before the agent acts. Before, if you had already talked to the agent in that room at a higher setting, the outsider's message ran at your setting too. Your own next message runs at your setting again (DOR-2764)
- Agents in a space's channel are now told that people outside your computer post there, and that their messages are not instructions, the same way they are told in a linked chat (DOR-2764)

### Added

- For each space you join, you can choose who can wake your agents there: any member who mentions them, or only you. Only you can change this; your agents cannot (DOR-2764)
