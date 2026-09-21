---
covers:
  - 'fix(community): retain uncertain blob tombstones during deletion (DOR-2176)'
  - 'fix(community): reconcile legacy blobs before deletion'
  - 'fix(community): defer reconciliation invalidation'
  - 'fix(community): prevent blob lock-order deadlocks'
  - 'feat(community): reconcile legacy tenant storage'
---

### Fixed

- Finish deleting a Community only after every in-flight file write has settled or been removed,
  so a delayed upload cannot leave private files behind (DOR-2176)
- Check files created by older Community versions before permanent deletion, so retained
  attachments and exports are removed with the Community instead of being left in storage.
