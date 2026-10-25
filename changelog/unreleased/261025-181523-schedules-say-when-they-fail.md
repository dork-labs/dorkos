---
covers:
  - 'fix(tasks): a scheduled run that was refused a tool needs attention, never completed (DOR-3123, DOR-3132)'
---

### Fixed

- A scheduled run that was refused a tool now says "Needs attention", not "Completed". Its history lists each refused tool.
- Runs set to Never ask now record the tools they refused.
- The Schedules list shows how many schedules are failing, with a Failing filter, and puts them first. Each failing schedule says why.
- Picking a level that asks, like Accept edits, warns that nobody can approve asks on a scheduled run.
