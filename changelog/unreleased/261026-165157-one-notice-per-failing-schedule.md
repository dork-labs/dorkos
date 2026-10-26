---
covers:
  - 'fix(tasks): a failing schedule sends one notice, not one per run (DOR-3123)'
  - "fix(tasks): a failing schedule's notice says why and points at the schedule, never a raise (DOR-3123)"
  - "fix(tasks): a failing schedule's notice reads like its row: two lines and the action below on a phone, the row's mark, the same phone text (DOR-3123)"
  - 'fix(tasks): a cut error never gets a full stop after its ellipsis (DOR-3123)'
  - 'fix(inbox): Open schedule lands on the failing schedules (DOR-3123)'
  - 'fix(client): the Schedules page declares its filters, so a link to failing schedules type-checks (DOR-3123)'
---

### Fixed

- A schedule that starts failing sends one notice. It says why and has an Open schedule button. No more arrive until it runs cleanly and fails again.
