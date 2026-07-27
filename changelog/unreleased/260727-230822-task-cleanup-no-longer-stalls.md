---
covers:
  - 'fix(tasks): the five-minute task sync no longer aborts on a deleted task'
---

### Fixed

- Tasks whose files you deleted now get cleared out properly. DorkOS checks your task files against its own records every five minutes, and that check had been failing every time on any setup where a deleted task had ever run. Deleted tasks lingered, edits made outside the app stopped catching up, and the error log filled with the same failure all day.
- Deleting a task from the Tasks page now works even after that task has run at least once. It used to fail with an error.
- Stopped the log filling with a warning about a missing file in your `tasks/templates` folder. That folder holds the starter tasks DorkOS ships with, so it is not a task itself and is no longer checked as one. A task folder of yours that really is missing its file is still reported.
