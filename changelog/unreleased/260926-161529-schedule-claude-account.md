---
covers:
  - 'feat(tasks): let a schedule name the Claude account its runs use (DOR-2384)'
  - "fix(tasks): honor a relay dispatch's account only from the scheduler, and lock sticky accounts on the merged schedule (DOR-2384)"
---

### Added

- Choose which of your Claude accounts pays for a scheduled task. Set `account:` in the task's `schedule:` block, or send `account` when you create or edit it, and its runs start on that account instead of the agent's. Changing the account on an approved schedule sends it back to you for approval, like a model change does. A schedule that keeps one conversation stays on the account it started on (DOR-2384).
