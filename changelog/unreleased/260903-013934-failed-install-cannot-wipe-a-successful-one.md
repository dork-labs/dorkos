---
covers:
  - 'fix(server): a failed install can no longer wipe out a concurrent successful one (DOR-711)'
  - 'fix(server): lock the install target by its real path, and share the lock with uninstall (DOR-711)'
---

### Fixed

- Installing or removing the same package in two places at once is safe. Before, a package could silently go back to an older version — one install failed, undid itself, and put the old files back on top of the other one that had just succeeded (DOR-711)
