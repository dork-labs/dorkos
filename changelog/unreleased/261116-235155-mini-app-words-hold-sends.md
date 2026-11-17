---
covers:
  - "fix(connectors): a mini app's room post holds sends and deletes like a stranger's words (DOR-4587)"
  - 'fix(connectors): the approval card names a turn that read outside words (DOR-4587)'
  - "fix(rooms): an agent's post relaying outside words keeps the outsider mark (DOR-4587)"
  - "fix(agents): a turn noted as reading outside words can't raise its mode, approve its own extension or write another agent's setup (DOR-4587)"
  - "refactor(turn-power): leave bridged chats' outside words as they were (DOR-4587)"
  - "fix(runtime): a Claude turn's connector send reads this turn's outside-words record, whatever id the SDK gives it (DOR-4587)"
---

### Fixed

- A mini app's reply in a room now limits the turn it starts, like a message from someone else: a send through a connected app asks you first. Before 0.135.13, from 0.125.0 on, it didn't.
