---
covers:
  - 'fix(rooms): pausing an agent mid-turn says it was paused, not that it broke (DOR-3178)'
---

### Fixed

- Pausing an agent while it is answering in a room now posts one line saying it is paused. Before, the room said the agent "ran into a problem", which read like a crash (DOR-3178).
