---
covers:
  - 'fix(client): stop offering an agent change a saved task cannot make (DOR-1694)'
  - 'fix(client): tell an unread agent list apart from a missing agent (DOR-1694 review)'
---

### Fixed

- Editing a scheduled task no longer lets you pick a different agent. The pick
  was always thrown away when you saved, and while it showed on screen the
  permission setting below it described the wrong agent — so you could move the
  dial a step and never be asked about it, then save a task that runs without
  stopping to ask. The edit screen now shows the agent it runs as and says the
  agent is set when a task is created (DOR-1694)
- While your list of agents is still loading, the edit screen no longer claims
  the task's agent is gone. If the list can't be read at all, it says that
  instead of blaming the task (DOR-1694)
