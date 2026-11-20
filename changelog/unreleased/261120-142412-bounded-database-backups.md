---
covers:
  - 'fix(db): bound database snapshot retention'
  - 'fix(db): cap pre-migration snapshots at three'
---

### Fixed

- Limit database backups to three daily copies and up to three pre-upgrade copies from the past week. Keep the newest recovery copy.
