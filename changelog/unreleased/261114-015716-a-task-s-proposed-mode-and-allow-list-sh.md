---
covers:
  - "fix(schedules): a task's proposed mode and allow list show on the approval card and apply exactly, scoped to its runs (DOR-3637)"
  - 'fix(schedules): looser modes, command rules and outsider rules each take a separate yes (DOR-3637)'
  - 'fix(schedules): approval card design review for requested rules, and a "Run it looser" demo (DOR-3637)'
  - 'fix(schedules): approval card names whose mode a test run uses, and a normal gap under the tick (DOR-3637)'
---

### Security

- When an agent proposes a schedule, the approval card shows what it asked to be allowed to do, and approving gives it exactly that, only for that schedule's runs. (DOR-3637)
- Giving a schedule more than it asked for, letting it run programs, or allowing rules on work written after reading outside words now each take a separate, clear choice. (DOR-3637)
