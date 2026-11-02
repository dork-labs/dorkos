---
covers:
  - 'fix(tasks): an agent can make and change scheduled tasks only for itself (DOR-3640)'
---

### Fixed

- An agent can no longer make or change a scheduled task for another agent. It can schedule work for itself, or work that belongs to no agent. Only its own schedules start without asking you, even when your agents are trusted.
- Schedule approvals and their notifications now say which agent the task runs as.
