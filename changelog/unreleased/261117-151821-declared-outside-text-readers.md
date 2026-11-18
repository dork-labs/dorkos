---
covers:
  - 'fix(turn-power): a task or agent can say it reads outside text, and only a person can take that back (DOR-3969)'
  - 'fix(turn-power): a task or agent set as reading outside text marks every turn it runs (DOR-3969)'
  - 'fix(turn-power): an agent whose reader status cannot be read is marked (DOR-3969)'
---

### Fixed

- A task or agent can be set as one that reads outside text, like mail or web pages. Its posts are then treated as outside words, and an agent can't switch that off.
