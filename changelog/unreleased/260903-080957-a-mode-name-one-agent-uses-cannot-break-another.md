---
covers:
  - 'fix(shared,server,client): a permission mode is whatever its runtime calls it (DOR-885)'
---

### Fixed

- A conversation that had a permission mode saved under a name one agent tool uses but another
  does not no longer breaks the next reply. It starts in the careful "ask me first" mode
  instead, and your saved choice is left exactly as you set it (DOR-885)
