---
covers:
  - 'feat(community): manage community settings and lifecycle'
  - 'feat(community): add administration lifecycle API'
  - 'fix(community): harden administration migration and deletion worker'
  - 'fix(community): retain uncertain blob tombstones during deletion (DOR-2176)'
  - 'fix(community): reconcile legacy blobs before deletion'
  - 'fix(community): defer reconciliation invalidation'
  - 'fix(community): prevent blob lock-order deadlocks'
  - 'feat(community): reconcile legacy tenant storage'
  - 'fix(community): retain rejected writer tombstones'
  - 'fix(community): authorize deletion reconciliation'
---

### Added

- Manage community settings, transfer ownership, archive and restore communities, and schedule deletion with a seven-day cancellation window. Host operators can create communities and manage hosting without access to private conversations.

### Fixed

- Stop community activity when access can no longer be verified. Keep local agent removal available during outages, and retry file cleanup before completing a community deletion.
