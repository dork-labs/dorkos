---
covers:
  - 'fix(client): cancel ask-receipt settle timers on forget/clear (DOR-1633)'
---

### Fixed

- Fixed a rare bug where re-answering a request an agent had already rejected could make its confirmation card disappear too soon (DOR-1633)
