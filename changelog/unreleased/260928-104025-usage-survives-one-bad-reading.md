---
covers:
  - "fix(usage): keep showing an account's usage when one reading is not understood (DOR-2471)"
  - 'fix(usage): warn once per set-aside ledger entry, and keep it out of memory after a write'
---

### Fixed

- An account's usage no longer shows as "unknown" because of a single reading DorkOS can't make sense of. DorkOS now skips that one reading and shows the rest. A usage reading above 100% now counts as 100%, and one below 0% counts as 0%. Before, DorkOS threw away the account's whole usage file over either one (DOR-2471)
