---
covers:
  - 'feat(rooms): a person is never left in silence (DOR-2823)'
  - "fix(rooms): Stop cancels a busy retry, and the receipt is the room's alone (DOR-2823)"
---

### Added

- When an agent is picked to answer your message in a room, 👀 appears on it right away, and goes away when the agent is done (DOR-2823)
- If nobody can answer your message in a channel, the room says why in one quiet line: there's no agent in it, or no lead (DOR-2823)

### Changed

- An agent that's busy in its own chat no longer skips your room message. The room tries again on its own and answers when the agent is free (DOR-2823)
- When an agent runs out of usage, the room says when it can answer again, instead of "ran into a problem" (DOR-2823)
