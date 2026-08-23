---
covers:
  - 'fix(server,client,shared): stop telling you a running task had finished when a second window steers it (DOR-1315)'
  - 'fix(server,client,shared): never say a task is running without checking, and say what the CLI can really steer (DOR-1315)'
---

### Fixed

- Steer a task from a second window while it is running, and the chip no longer
  claims the task had already finished. It says what is actually true: something
  else is running this task, so your message is waiting in line (DOR-1315).
