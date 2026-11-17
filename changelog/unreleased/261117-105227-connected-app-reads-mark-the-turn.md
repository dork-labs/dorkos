---
covers:
  - 'fix(connectors): a read through a connected app marks the turn it ran in (DOR-3969)'
  - "fix(connectors): a connected-app read never latches the owner's own linked chat as a stranger's (DOR-3969)"
---

### Fixed

- After an agent reads your mail or another connected app (Connections page), a send in that same turn asks you first. What it read was written by someone else, and could try to steer it.
