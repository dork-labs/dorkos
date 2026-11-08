---
covers:
  - 'feat(db): an extension can hold a connection grant, by a typed id the database enforces (DOR-3547)'
---

### Added

- Prepare DorkOS's database for mini apps that read a connected app themselves: an extension's grant names it in a field of its own, and the database refuses any row that mixes up an extension and an agent (DOR-3547)
