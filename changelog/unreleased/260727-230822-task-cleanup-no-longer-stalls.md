---
covers:
  - 'fix(tasks): the five-minute task sync no longer aborts on a deleted task'
  - 'fix(tasks): a task file that is on disk is never treated as deleted'
---

### Fixed

- DorkOS checks your task files against its own records every five minutes. That check gave up on the first deleted task it met, so deleted tasks lingered and edits you made outside the app stopped showing up. It now finishes.
- Deleting a task now works even if that task has run before. It used to fail with an error.
- A typo in a task file no longer costs you the task. A file DorkOS cannot read is left alone, so fixing the typo picks up where you left off, run history intact.
- Two tasks with the same name in different projects no longer interfere. One losing its file used to pause the other.
- A task paused because its file went missing now runs again once the file is back.
- Stopped the repeated log warning about a missing file in your `tasks/templates` folder. That folder holds the starter tasks DorkOS ships with, so it is not a task itself. A task folder of yours that really is missing its file is still reported.
