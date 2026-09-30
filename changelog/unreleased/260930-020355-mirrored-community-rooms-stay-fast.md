---
covers:
  - 'perf(rooms): fill and page mirrored Community rooms without reading the whole room'
---

### Changed

- Keep big Community rooms fast in the app. Loading a room's history used to slow down more and more as the room grew: 4,000 messages took about seven minutes, and 100,000 would have taken days. It now takes under a minute for 100,000. Scrolling back through a room that size also went from about a tenth of a second per page to under a millisecond. (DOR-2573)
