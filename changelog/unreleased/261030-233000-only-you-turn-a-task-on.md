---
covers:
  - 'fix(tasks): approving or a file change never turns a task on (DOR-3309)'
---

### Fixed

- Approving a task or changing its file no longer turns a scheduled task back on. Approving a task you had switched off now keeps it off: "Approve" leaves it off, and "Approve and turn on" beside it turns it on too. And when a task's file starts saying it is on again (a git pull that restores `enabled: true`, or a file with no `enabled` line), the task stays off and its row says "Its file says on. It stays off until you switch it on." Use the row's switch to turn it on. A file can still switch a task off. (DOR-3309)
