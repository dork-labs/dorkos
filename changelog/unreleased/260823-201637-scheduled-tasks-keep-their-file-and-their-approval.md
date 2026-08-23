---
covers:
  - 'fix(server,shared): a scheduled task keeps its file, and its approval (DOR-1481)'
---

### Fixed

- Clearing a scheduled task's time limit, display name, or timezone no longer breaks the task's file. DorkOS used to write the cleared field as the word `null`, which it could not read back — after that the task stopped syncing, and every later edit to it quietly failed to save. (DOR-1481)
- When DorkOS cannot save a task's file — the disk is full, or the file is read-only — editing the task now fails with a message saying which file it could not write. It used to report success, then put the old values back a few minutes later with nothing to explain why. (DOR-1481)
- A time limit DorkOS cannot read, like `10 minutes`, is now refused when you edit a task, exactly as it already was when you create one. It used to be accepted and then removed the task's time limit altogether. Write it as `10m`. (DOR-1481)

### Security

- Only a person can run a scheduled task on demand. An agent could ask DorkOS to run a task right now — including one that was parked, waiting for you to approve it — which walked straight around the approval. You can still run a proposed task once from its approval card to see what it does. (DOR-1481)
