---
covers:
  - 'fix(rooms): update an open room when a Community message is deleted or erased (DOR-2336)'
---

### Fixed

- An open room now updates when a Community message is deleted or erased. The message changes to its "deleted" or "erased" note right where it sits, including inside a thread, without reloading the room. Before, the old words stayed on screen until you closed and reopened it. A room that was open while your computer was asleep catches up when it reconnects.
