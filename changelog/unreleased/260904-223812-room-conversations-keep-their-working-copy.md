---
covers:
  - "fix(server): a resumed room conversation runs in the room's working copy (DOR-1624)"
---

### Fixed

- A project-room conversation you carry on somewhere other than the room now continues in the same working copy the agent has been using in that room, so the work it has not saved into the room's files yet is right there. Before, it started up in the agent's own folder instead, and that work was invisible. If you name a folder yourself, yours still wins (DOR-1624)
