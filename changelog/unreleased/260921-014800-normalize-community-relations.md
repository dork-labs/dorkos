---
covers:
  - 'feat(community): normalize tenant relation arrays'
  - 'feat(community): enforce tenant relational contract'
  - 'fix(community): keep tenant reconciliation out of startup'
---

### Changed

- Preserved Community mentions and export channel order in tenant-safe database relations while keeping existing single-Community behavior.
- Kept ordinary Community startup independent of the one-time storage reconciliation used before adding a second community.
