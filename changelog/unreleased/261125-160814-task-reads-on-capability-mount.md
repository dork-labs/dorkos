---
covers:
  - 'fix(api): the scheduled task list and run reads are served by the capability mount (DOR-4978)'
---

### Changed

- An agent reading scheduled task runs through the API now sees only runs of its own scheduled tasks and of tasks that belong to no agent, the same as its own run history tool. It no longer sees another agent's runs, what they wrote, or which chat they ran in.
- Reading scheduled tasks and their runs now follows an agent's Tasks permission. If you set Tasks to Blocked for an agent, it can no longer read them through the API either.
- When scheduled tasks are not running on a computer, asking for the task list or a run now says so, instead of answering "not found".
