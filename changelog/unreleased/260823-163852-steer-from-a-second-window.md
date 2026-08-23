---
covers:
  - 'fix(server,client,shared): stop telling you a running task had finished when a second window steers it (DOR-1315)'
---

### Fixed

- Steer a task from a second window while it is running, and the chip no longer
  claims the task had already finished. It says what is actually true: another
  window is running this task, so your message waits in line (DOR-1315).
