---
covers:
  - 'fix(server): a vanished avatar file no longer crashes the server (DOR-1830)'
---

### Fixed

- Loading a profile photo at the moment it was replaced or removed could take the whole server down, rather than just failing that one request. Photos are now read from disk once instead of twice, which removes the crash and also fixes a subtler problem: the version tag your browser caches could name different bytes than the ones it was actually sent.
