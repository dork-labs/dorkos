---
covers:
  - 'fix(client): open a room agent’s room session, not its newest chat (DOR-1974)'
  - "fix(client): re-read a room's bindings before opening a session (DOR-1974)"
---

### Fixed

- Opening an agent's session from inside a channel now takes you to the conversation that agent is having in that channel, instead of an unrelated one.
