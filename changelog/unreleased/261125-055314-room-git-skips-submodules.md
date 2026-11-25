---
covers:
  - 'fix(rooms): a room's copy refresh reads submodules without running them (DOR-5246)'
---

### Fixed

- Rooms that keep files never run anything inside a submodule someone adds to a copy or the room's own folder. Such a copy waits for a person before it is brought up to date, and files beside a submodule are not saved (DOR-5246).
