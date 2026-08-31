---
covers:
  - 'fix(server): give agent token revocation its first production caller (DOR-490)'
---

### Fixed

- Deleting or unregistering an agent now actually turns off its identity, instead of leaving its access tokens valid until they expire on their own schedule
