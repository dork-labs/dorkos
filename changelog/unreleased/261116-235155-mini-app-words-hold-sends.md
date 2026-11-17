---
covers:
  - "fix(connectors): a mini app's room post holds sends and deletes like a stranger's words (DOR-4587)"
  - 'fix(connectors): the approval card names a turn that read outside words (DOR-4587)'
  - "fix(rooms): an agent's post relaying outside words keeps the outsider mark (DOR-4587)"
---

### Fixed

- A mini app's reply in a room now limits the turn it starts, like a message from someone else: a send through a connected app asks you first. Before 0.135.13, from 0.125.0 on, it didn't.
