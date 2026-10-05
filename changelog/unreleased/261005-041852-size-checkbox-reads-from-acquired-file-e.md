---
covers:
  - 'fix(server): size checkbox reads from acquired file evidence'
---

### Fixed

- Avoid oversized allocations when recovering small document checkbox writes while preserving file growth and size checks.
