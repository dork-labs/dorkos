---
covers:
  - 'fix(community): let a community be deleted after one of its exports expired'
---

### Fixed

- A Community whose owner once downloaded an export can be deleted again after that export expires. Before, asking to delete it failed every time with "Storage ownership must be reconciled before deleting this community." (DOR-2269).
