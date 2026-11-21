---
covers:
  - 'fix(db): bound database snapshot retention'
  - 'fix(db): cap pre-migration snapshots at three'
  - 'fix(db): preserve backups made before bounded retention'
  - 'fix(db): clean legacy unfinished snapshots'
---

### Fixed

- DorkOS now keeps the last 3 daily backups it makes. Older backups you already have aren't touched.
