---
covers:
  - 'fix(server): an agent asked in a room thread answers in that thread (DOR-3252)'
---

### Fixed

- When you write to an agent inside a room thread, its answer now lands in that thread every time. Before, some answers showed up in the main channel instead. An agent asked in the main channel still answers there. (FB-63)
