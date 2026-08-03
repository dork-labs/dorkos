---
covers:
  - 'fix(client): the detail-cache sync stops trusting arrival order (DOR-496)'
---

### Fixed

- Switching a session to a mode that stops asking permission now sticks, even if DorkOS happened to be refreshing its session list at that exact moment. The refresh could come back carrying the setting from a second earlier and quietly undo the change on screen — so the warning icon disappeared while the agent really was running without asking.
