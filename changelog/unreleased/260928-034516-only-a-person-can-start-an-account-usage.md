---
covers:
  - 'fix(server): only a person can start an account usage check over HTTP (DOR-2381)'
---

### Fixed

- Only a person can start a check of an idle Claude account's usage through the DorkOS API: when login is on, you need to be signed in, and an agent is refused there. Agents check usage with their own tool, which goes through your approval settings (DOR-2381).
