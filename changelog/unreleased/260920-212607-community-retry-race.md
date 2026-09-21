---
covers:
  - 'fix(community): make packaged acceptance retry proof deterministic'
  - 'fix(community): accept retries after backoff becomes due'
---

### Fixed

- Keep a Community message retry moving when its automatic retry is due or starts just before you click **Retry now** (DOR-2164, DOR-2209)
