---
covers:
  - "feat(rooms): read a room's history past the first page (DOR-1734)"
---

### Added

- You can now scroll back through a room's older messages. A room opens on its
  most recent fifty, and an "Older messages" button at the top loads the fifty
  before those — as many times as you like, back to the day the room started.
  The room keeps your place when the older messages land (DOR-1734)

### Fixed

- A thread's "3 replies" line now counts every reply the room has on screen. It
  could fall behind when a reply arrived while you were reading (DOR-1734)
