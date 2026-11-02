---
covers:
  - 'feat(rooms): an agent can move its own room seat to another account, within four limits (DOR-3145)'
---

### Added

- An agent can now move itself to another Claude account in a room or DM, so it keeps answering when its account runs low. It may move only itself, and only once its account is at 80% of its usage or more. It never moves onto your main account or one you keep out of automatic moves, and never from a turn that read words from outside. If its usage can't be read, it doesn't move. The room gets a line on every move.
