---
covers:
  - 'fix(tasks): a scheduled run that was refused a tool needs attention, never completed (DOR-3123, DOR-3132)'
  - "fix(tasks): the schedule form's warning names the fix, and a never-ask deny never waits on its record (DOR-3123, DOR-3132)"
  - 'fix(tasks): a long schedule name no longer crushes the agent name on a phone (DOR-3123)'
---

### Fixed

- A scheduled run that was refused a tool now says "Needs attention", not "Completed". Its history lists each refused tool.
- Runs set to Never ask now record the tools they refused.
- The Schedules list shows how many schedules are failing, with a Failing filter, and puts them first. Each failing schedule says why.
- Picking a level that asks, like Accept edits, warns that nobody can approve asks on a scheduled run.
