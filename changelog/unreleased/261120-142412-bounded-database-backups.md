---
covers:
  - 'fix(db): bound database snapshot retention'
---

### Fixed

- Limit old database backups to three daily copies and ten pre-upgrade copies from the past week. Keep the newest recovery copy.
