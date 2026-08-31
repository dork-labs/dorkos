---
covers:
  - 'fix(client): guard the loudness pill and Remove button against drawer-drag clicks (DOR-1275)'
---

### Fixed

- On a phone, swiping the room sheet closed could accidentally open a
  member's loudness scale or ask to remove them, if the swipe passed over one
  of those buttons (DOR-1275)
