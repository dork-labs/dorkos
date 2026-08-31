---
covers:
  - 'fix(server): decode file:// marketplace paths with spaces or Windows drive letters (DOR-412)'
---

### Fixed

- Installing a marketplace package from a local `file://` source whose path contains a space
  no longer fails to read the directory (DOR-412).
