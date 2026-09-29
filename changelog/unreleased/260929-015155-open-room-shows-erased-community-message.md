---
covers:
  - 'fix(rooms): update an open room when a Community message is deleted or erased (DOR-2336)'
  - 'fix(rooms): narrow the revision claims and pin the words-only swap (DOR-2336 review)'
---

### Fixed

- When you open a Community message from search and it is then deleted or erased on the Community, the message now changes to its "deleted" or "erased" note right where it sits, including inside a thread, without reloading. Before, the old words stayed on screen until you closed and reopened it.
