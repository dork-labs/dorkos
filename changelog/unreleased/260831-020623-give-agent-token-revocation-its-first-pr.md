---
covers:
  - 'fix(server): give agent token revocation its first production caller (DOR-490)'
---

### Fixed

- Deleting or unregistering an agent now actually turns off its identity — its access tokens stop working immediately instead of only expiring on their own schedule
