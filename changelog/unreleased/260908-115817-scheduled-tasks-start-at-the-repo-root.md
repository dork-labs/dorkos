---
covers:
  - 'fix(server): scheduled tasks start at the repo root in dev too'
---

### Fixed

- Scheduled tasks now start in the right folder when you run DorkOS from source. They were starting one folder too deep, so a task with no workspace of its own could not see the project it was meant to work on.
