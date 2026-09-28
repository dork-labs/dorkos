---
covers:
  - 'fix(extensions): rebuild an extension when any file it imports changes (DOR-2491)'
---

### Fixed

- Updating an extension now always loads its new code, even when only a file it imports changed. Before, DorkOS could keep running the old version until someone cleared its build cache by hand (DOR-2491)
