---
covers:
  - 'fix(usage): a limit notice with no number keeps the usage percent it found (DOR-3589)'
---

### Fixed

- An account's usage percent no longer goes blank after a limit notice. Claude sometimes sends a notice with only a status, like "close to the limit". The account now keeps the last percent it measured and shows the new status beside it. When the window has reset, the old percent goes away as it should.
