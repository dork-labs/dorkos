---
covers:
  - 'fix(tasks): approving or a file change never turns a task on (DOR-3309)'
---

### Fixed

- Only you turn a scheduled task on. Approving a task you had switched off now keeps it off: the card offers "Approve (stays off)" first and "Approve and turn on" beside it. And when a task's file starts saying it is on again (a git pull that restores `enabled: true`, or a file with no `enabled` line), the task stays off and its row says "The file turns this task on" with a **Turn on** button. A file can still switch a task off. (DOR-3309)
