---
covers:
  - 'fix(rooms): a post handed to a busy room chat is posted after two minutes when the room has not moved on (DOR-4252)'
---

### Fixed

- When an agent's other chat sends a post to a room while the agent's chat there is busy, DorkOS now posts it as written after two minutes, if that other chat had read the room and nothing new was said since. Otherwise the agent's chat in the room reads it when it's free and posts it or says why not, as before. The sending chat is told this when it sends. (DOR-4252)
