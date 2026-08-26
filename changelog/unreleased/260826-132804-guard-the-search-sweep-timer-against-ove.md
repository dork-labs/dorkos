---
covers:
  - 'fix(server): guard the search sweep timer against overlapping passes'
---

### Fixed

- DorkOS keeps a searchable copy of your messages and catches it up every five minutes. If your history is large enough that one catch-up takes longer than five minutes, DorkOS no longer starts a second one on top of it. The two used to run at the same time and redo the same work. (DOR-1578)
