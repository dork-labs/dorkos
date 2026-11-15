---
covers:
  - 'fix(connections): keep deleting batches outside access levels (DOR-4194, DOR-4270)'
  - 'fix(connections): distinguish ordinary creation from destructive updates (DOR-4194, DOR-4270)'
  - 'fix(connections): keep reviewed exceptions out of app access levels (DOR-4194, DOR-4270)'
  - 'feat(connections): allow clean Composio writes for every app (DOR-4194, DOR-4270)'
---

### Changed

- “Read and write” now works for every connected app. Agents can create and edit there. Deleting, sharing, spending money and changing who has access still need you to pick those actions one by one. (DOR-4194, DOR-4270)
