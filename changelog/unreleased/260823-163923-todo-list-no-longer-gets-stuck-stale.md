---
covers:
  - 'fix(client,server): stop to-do updates from silently missing their task (DOR-1441)'
  - 'fix(client,server,shared): to-do updates always land on the right task, even right after it was created (DOR-1441)'
  - 'fix(client,server,shared): close the remaining to-do id gaps — safe result parsing, todo/task id collision, old-row replay (DOR-1441)'
---

### Fixed

- Fixed the to-do list sometimes getting stuck showing old status or counts, even after refreshing. A task's progress update could miss the task it was meant for and quietly do nothing — or, rarer, land on the wrong task instead.
