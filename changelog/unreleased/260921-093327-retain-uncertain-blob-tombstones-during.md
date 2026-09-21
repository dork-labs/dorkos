---
covers:
  - 'fix(community): retain uncertain blob tombstones during deletion (DOR-2176)'
---

### Fixed

- Finish deleting a Community only after every in-flight file write has settled or been removed,
  so a delayed upload cannot leave private files behind (DOR-2176)
