---
covers:
  - 'feat(security): deleting a scheduled task or an agent asks you first (DOR-468)'
---

### Security

- Ask you first before an agent deletes one of your scheduled tasks. Deleting a task
  cannot be undone, so it now waits for your approval like removing a package does
  (DOR-468)
- Ask you first before an agent removes another agent. That one call used to take
  three things at once: the agent, its setup file on disk, and its scheduled tasks
  (DOR-468)
- Sort every tool an agent can reach into read-only, changes-something, and
  cannot-be-undone, so a new tool cannot arrive without somebody deciding which it is.
  Only the two above wait for you; everything else runs exactly as before (DOR-468)
