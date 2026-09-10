---
covers:
  - 'fix(connections): bound managed sign-in waits (DOR-1965)'
---

### Fixed

- Long-running managed account setup now gets a bounded window to finish before DorkOS reports an uncertain result. Failures keep private account details out of logs.
