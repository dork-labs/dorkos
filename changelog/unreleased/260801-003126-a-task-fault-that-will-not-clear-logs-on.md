---
covers:
  - 'fix(tasks): a task fault that will not clear logs once an hour, not twelve times'
---

### Fixed

- A task problem that sticks around no longer repeats in your log every five minutes. DorkOS checks your task files on a timer, so one bad file used to write the same line twelve times an hour, all day, burying anything else that went wrong. You now get the full message the first time it happens, then one reminder an hour that says how many times it has repeated. A different problem always shows up right away.
