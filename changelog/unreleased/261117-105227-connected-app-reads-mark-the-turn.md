---
covers:
  - 'fix(connectors): a read through a connected app marks the turn it ran in (DOR-3969)'
  - "fix(connectors): a connected-app read never latches the owner's own linked chat as a stranger's (DOR-3969)"
  - "fix(approvals): a card a turn's outside words raised says why (DOR-3969)"
  - "refactor(approvals): the card's outside-words reason is set where the card is built (DOR-3969)"
---

### Security

- After an agent reads mail, a web page or another app, any send through a connected app in that turn now asks you first.
- After an agent reads your mail or another connected app (Connections page), a send in that same turn asks you first, and the card says why. What it read was written by someone else, and could try to steer it.
- Files an agent reads and commands it runs (such as curl or git) don't mark the turn yet.
