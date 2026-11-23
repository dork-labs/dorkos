---
covers:
  - 'fix(todos): a to-do tool marks a turn only when a to-do it hands back holds outside words (DOR-4666)'
---

### Fixed

- With to-dos on, an agent that adds or reads your team's own to-dos can still send through a connected app without asking, and can add more than one to-do in a turn. A to-do that holds a stranger's words still makes it ask first (DOR-4666).
