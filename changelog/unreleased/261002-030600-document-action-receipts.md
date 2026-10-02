---
covers:
  - 'fix(canvas): mark grants from former owners unavailable'
  - 'fix(canvas): preserve accepted work across transient claim failures'
  - 'fix(canvas): preserve append-only comments and verify accounting indexes'
  - 'feat(canvas): persist document events and enforce approved routes'
---

### Added

- Save document actions with receipts that survive retries. Agents can acknowledge specific actions and update document state. Permissions stay tied to the account that approved them. (DOR-2665)
