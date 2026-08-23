---
covers:
  - 'fix(client,server): stop to-do updates from silently missing their task (DOR-1441)'
---

### Fixed

- Fixed the to-do list sometimes getting stuck showing old status or counts, even after refreshing. A task's progress update could miss the task it was meant for and quietly do nothing.
