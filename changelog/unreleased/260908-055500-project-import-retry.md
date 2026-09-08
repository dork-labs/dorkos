---
covers:
  - 'fix(mesh): keep failed project imports retryable (DOR-1897)'
---

### Fixed

- Projects can now be added when their own folder is the scan root. If adding a project fails, it stays in the list with a clear retry action (DOR-1897).
