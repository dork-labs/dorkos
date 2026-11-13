---
covers:
  - 'feat(mcp): audit remote sessions and expose key last use (DOR-4206)'
---

### Added

- Every tool session from another device now goes in the audit log, with which key it used. The log never keeps the key itself or what the tool was asked to do.
