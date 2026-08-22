---
covers:
  - 'fix(server): the first session after a server boot no longer relaunches its warm process on message 2 (DOR-1308)'
---

### Fixed

- With Keep agents warm between messages on, the very first chat after starting DorkOS now gets its fast second reply too — it no longer quietly restarts its agent once.
