---
covers:
  - 'fix(tasks): a failing schedule sends one notice, not one per run (DOR-3123)'
  - "fix(tasks): a failing schedule's notice says why and points at the schedule, never a raise (DOR-3123)"
  - "fix(tasks): a failing schedule's notice reads like its row: two lines and the action below on a phone, the row's mark, the same phone text (DOR-3123)"
---

### Fixed

- A schedule that starts failing sends one notice. It says why and has an Open schedule button. No more arrive until it runs cleanly and fails again.
