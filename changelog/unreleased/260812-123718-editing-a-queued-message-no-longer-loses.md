---
covers:
  - 'fix(server,shared): stale queue-era narration corrected, and a real reorder-edit bug fixed (DOR-1178)'
---

### Fixed

- Rewording a message waiting in the queue while also moving it now checks the move first.
  Before, a move to a spot in the queue that had already been taken could still fail after
  your new words had already been saved — you'd see an error, but your edit had gone through
  anyway with no notice to anyone watching the queue
