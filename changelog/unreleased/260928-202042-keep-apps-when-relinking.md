---
covers:
  - "feat(cloud): keep a computer's apps when it links the DorkOS account again (DOR-2521)"
---

### Changed

- Link this computer again with the same DorkOS account and the apps it connected through its earlier link can come back, instead of needing to be connected one by one. This works after you unlink in Settings or run `dorkos cloud logout`. If the earlier link was removed from your DorkOS account, or you link a different account or a different computer, connect those apps again. For this, DorkOS keeps a proof that it held the old key, never the key itself (DOR-2521)
