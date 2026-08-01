---
covers:
  - 'fix(tasks): the five-minute task sync no longer aborts on a deleted task'
  - 'fix(tasks): a task file that is on disk is never treated as deleted'
  - 'fix(tasks): only a folder DorkOS actually read can retire a task'
  - 'fix(tasks): check the file itself before retiring a task'
  - 'fix(tasks): a file in the templates folder never becomes a task'
  - 'fix(tasks): a folder DorkOS cannot see never counts as evidence a task is gone'
---

### Fixed

- DorkOS checks your task files against its own records every five minutes. That check gave up on the first deleted task it met, so deleted tasks lingered and edits you made outside the app stopped showing up. It now finishes.
- Deleting a task now works even if that task has run before. It used to fail with an error.
- Before removing a task, DorkOS now double-checks that its file is really gone. Tasks whose folder is a shortcut to somewhere else were being removed while the file sat there untouched.
- A typo in a task file no longer costs you the task. A file DorkOS cannot read is left alone, so fixing the typo picks up where you left off, run history intact.
- Tasks in a project folder DorkOS is not currently watching are no longer cleared out. This hit tasks you added for an agent connected after startup, and tasks belonging to an agent you disconnected.
- Two tasks with the same name in different projects no longer interfere. One losing its file used to pause the other.
- A task paused because its file went missing now runs again once the file is back.
- Stopped the repeated log warning about a missing file in your `tasks/templates` folder. That folder holds the starter tasks DorkOS ships with, so it is not a task itself. A task folder of yours that really is missing its file is still reported.
- A task file placed loose in your `tasks/templates` folder no longer turns into a task. It became one that ran on a schedule, and deleting it took every one of your templates with it.
- Tasks in a project folder that has been deleted or unmounted are no longer cleared out. DorkOS could not tell an empty folder from one that is not there any more, so a checkout you moved took its tasks and their history with it.
- Updating no longer fails if your database holds run records whose task is already gone. Those leftovers would have stopped DorkOS from starting at all, with no way to fix it from inside the app. They are tidied up during the update.

### Changed

- Deleting a task now also deletes its run history, and that is permanent. Before this, deleting a task with any run history simply failed with an error, so nothing was lost — and nothing was deleted either. Two knock-on effects worth knowing: the runs are gone from the task's history for good, and any chat session that task started will no longer show that it came from a task.
- Naming a new task "Templates" is now refused, with a message asking for a different name. That folder name is reserved for the starter tasks.
- To pause a task, switch it off. Marking a task "paused" directly is no longer accepted, because it never lasted — DorkOS uses that mark for its own purposes, such as noting that a task's file has gone missing.
