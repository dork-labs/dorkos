---
covers:
  - 'fix(api): a missing audit event tells agents AUDIT_EVENT_NOT_FOUND, and the mount knows its own routes (DOR-4978)'
---

### Fixed

- When an agent asks for an audit log entry it can't see, it now gets the code `AUDIT_EVENT_NOT_FOUND` instead of `NOT_FOUND` (DOR-4978)
