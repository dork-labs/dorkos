---
covers:
  - 'fix(community): authorize deletion reconciliation'
---

### Fixed

- Community deletion retries now return their existing progress without rerunning storage checks,
  and only an owner can start those checks.
