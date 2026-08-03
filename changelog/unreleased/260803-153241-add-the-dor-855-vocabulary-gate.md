---
covers:
  - 'feat(scripts): add the DOR-855 vocabulary gate'
---

### Added

- Internal: a build check now catches "Connection" creeping back into network-status
  copy, so the DOR-855 rename stays put instead of quietly drifting back over time.
  No user-visible change (DOR-855)
