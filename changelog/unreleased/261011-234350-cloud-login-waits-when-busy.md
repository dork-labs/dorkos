---
covers:
  - 'fix(server): cloud login backs off on a 429 instead of giving up (DOR-2496)'
---

### Fixed

- `dorkos cloud login` now waits and tries again when DorkOS Cloud says it is busy, instead of giving up and making you start over (DOR-2496)
