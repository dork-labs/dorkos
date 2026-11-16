---
covers:
  - "fix(schedules): a task's proposed mode and allow list show on the approval card and apply exactly, scoped to its runs (DOR-3637)"
  - 'fix(schedules): looser modes, command rules and outsider rules each take a separate yes (DOR-3637)'
  - 'fix(schedules): approval card design review for requested rules, and a "Run it looser" demo (DOR-3637)'
  - 'fix(schedules): approval card names whose mode a test run uses, and a normal gap under the tick (DOR-3637)'
  - "fix(schedules): the approval card's tick row is a 44px target on touch screens (DOR-3637)"
  - 'fix(schedules): one click never grants more than the tightest of the saved and requested modes, and a trial is held to it (DOR-3637)'
  - 'fix(schedules): glob rules take the tick, a trial starts a fresh chat, and checks use the runtime a run starts on (DOR-3637)'
  - 'fix(schedules): file rules are judged by their shape, so no spelling of home or .git slips past the tick (DOR-3637)'
  - 'fix(schedules): a Read rule that climbs out with .. takes the tick too (DOR-3637)'
  - 'fix(schedules): the approval tick names the mode it allows (DOR-3637)'
---

### Security

- When an agent proposes a schedule, the approval card shows what it asked to be allowed to do, and approving gives it exactly that, only for that schedule's runs. (DOR-3637)
- Giving a schedule more than it asked for or more than it had, letting it run programs, change files outside its folder or read files by a broad pattern, or allowing rules on work written after reading outside words now each take a separate, clear choice. A test run before approval never runs looser than one click could approve. (DOR-3637)
