---
covers:
  - 'feat(rooms): a person is never left in silence (DOR-2823)'
  - "fix(rooms): Stop cancels a busy retry, and the receipt is the room's alone (DOR-2823)"
  - "fix(rooms): receipts never spend an agent's reactions, and a chosen no-lead channel stays quiet (DOR-2823)"
---

### Added

- When an agent is picked to answer your message in a room, 👀 appears on it right away, and goes away when the agent is done (DOR-2823)
- If you write in a channel that has no agent in it, the room says so in one quiet line (DOR-2823)

### Changed

- An agent that's busy in its own chat no longer skips your room message. The room tries again on its own and answers when the agent is free (DOR-2823)
- When an agent runs out of usage, the room says when it can answer again, instead of "ran into a problem" (DOR-2823)
