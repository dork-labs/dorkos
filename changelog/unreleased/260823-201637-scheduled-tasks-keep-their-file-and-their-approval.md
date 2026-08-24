---
covers:
  - 'fix(server,shared): a scheduled task keeps its file, and its approval (DOR-1481)'
  - 'fix(server,shared): clearing a cron, and a task file DorkOS cannot read (DOR-1481 review)'
---

### Fixed

- Clearing a scheduled task's time limit, display name, timezone, or cron no longer breaks the task's file. DorkOS used to write the cleared field as the word `null`, which it could not read back — after that the task stopped syncing, and every later edit to it quietly failed to save. (DOR-1481)
- Editing a task that runs only on demand now works. Saving one from the task form cleared its cron, which the database refused, so the edit failed — after the file on disk had already been rewritten, letting the half-finished edit apply itself seconds later. (DOR-1481)
- When DorkOS cannot save a task's file — the disk is full, or the file is read-only — editing the task now fails with a message naming the file it could not write. It used to report success, then put the old values back a few minutes later with nothing to explain why. (DOR-1481)
- A task whose file DorkOS cannot read or make sense of now says so when you edit it, and names the file to open. Editing one used to quietly succeed while the file stayed broken, so a damaged task had no visible symptom at all. (DOR-1481)
- A time limit DorkOS cannot read, like `10 minutes`, is now refused when you edit a task, exactly as it already was when you create one — through the task form, the API, and the `tasks_update` tool an agent uses. It used to be accepted and then removed the task's time limit altogether. Write it as `10m`. (DOR-1481)

### Security

- Only a person can run a scheduled task on demand. An agent could ask DorkOS to run a task right now — including one that was parked, waiting for you to approve it — which walked straight around the approval. You can still run a proposed task once from its approval card to see what it does. (DOR-1481)
