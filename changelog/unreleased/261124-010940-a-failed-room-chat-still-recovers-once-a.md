---
covers:
  - 'fix(rooms): a failed room chat still recovers once after DorkOS restarts (DOR-4626)'
---

### Fixed

- When an agent's chat in a room stopped on a server error and DorkOS then restarted, the next post handed to that room used to fail. The agent now gets one fresh chat there, as it would have without the restart, with the same limits its old chat had (DOR-4626).
