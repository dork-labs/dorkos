---
covers:
  - "fix(schedules): a task's proposed mode and allow list show on the approval card and apply exactly, scoped to its runs (DOR-3637)"
---

### Security

- When an agent proposes a schedule, the approval card shows what it asked to be allowed to do, and approving gives it exactly that, only for that schedule's runs. (DOR-3637)
- Giving a schedule more than its agent asked for now takes a separate, clear choice. (DOR-3637)
