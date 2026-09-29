---
covers:
  - "fix(communities): keep a held community's files from the cleanup sweep, and settle two lock orders (DOR-2553, DOR-2330)"
---

### Fixed

- On a Community server, a legal hold now also keeps files that were already waiting to be deleted when the hold was placed. They are deleted once the hold is released.
- On a Community server, an export that starts while a member is being erased, or while the host takes something down, no longer fails and has to retry. Deleting an abandoned import's files while the regular cleanup reaches the same file no longer fails either.
