---
covers:
  - 'feat(client): the scheduler says "scheduled tasks", everywhere (DOR-1490)'
  - 'feat(server,shared,cli): the tasks MCP tools describe scheduled tasks (DOR-1490)'
  - 'docs: the scheduled-tasks guide follows the schedule: block (DOR-1490)'
  - 'fix(client,server,docs,e2e): one noun per object, on every renderer (DOR-1490)'
---

### Changed

- The scheduler now calls its work **scheduled tasks**, and **Schedules** where a label has no room. The word "task" was doing two jobs: the thing you put on a timer, and the to-do list an agent keeps while it works on your message. Now only one of them is called a task, and the tab, the page, the dialogs, the command palette and the activity feed all say the same word (DOR-1490)
- The guide is rewritten around what actually changed underneath: any skill becomes a scheduled task when you add a few lines of timing to it, and DorkOS finds it wherever your skills live. It covers where DorkOS looks, why nothing runs until you approve it, what happens to schedules you already had, and the one gotcha worth knowing before you flag a skill as "do not pick this up on your own" (DOR-1490)
- The `/flow` guides now show the new format and both steps: set `schedule.enabled: true` in the file, then approve `flow-drain` on the Schedules page. The flag says what you want; the approval is what lets it run (DOR-1490)
