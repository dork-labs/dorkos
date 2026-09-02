---
covers:
  - 'fix(client): stop offering an agent change a saved task cannot make (DOR-1694)'
---

### Fixed

- Editing a scheduled task no longer lets you pick a different agent. The pick
  was always thrown away when you saved, and while it showed on screen the
  permission setting below it described the wrong agent — so you could move the
  dial a step and never be asked about it, then save a task that runs without
  stopping to ask. The edit screen now shows the agent it runs as and says the
  agent is set when a task is created (DOR-1694)
