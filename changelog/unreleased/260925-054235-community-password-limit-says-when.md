---
covers:
  - 'fix(community): tell a client how long to wait after too many wrong passwords (DOR-2275)'
---

### Fixed

- When a Community server refuses a request because of too many wrong passwords, or another per-minute limit, it now says how many seconds to wait, in a standard `Retry-After` header. Wrong passwords on every action that asks for one (leaving, disconnecting installations, handing over ownership, exporting, archiving, deleting, API keys and erasure) still count together, per account, and a test now covers each of those actions (DOR-2275)
