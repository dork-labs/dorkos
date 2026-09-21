---
covers:
  - 'feat(community): make first-host setup atomic'
---

### Fixed

- Setting up a new Community now creates the first account, owner, and channel together, so a failed or competing setup cannot leave a half-created space behind. (DOR-2181)
