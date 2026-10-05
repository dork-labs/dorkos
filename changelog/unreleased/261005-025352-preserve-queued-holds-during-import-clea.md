---
covers:
  - 'fix(community): preserve queued holds during import cleanup'
---

### Fixed

- Stop import file cleanup after the file already being deleted when a legal hold is placed, preserving the remaining files.
