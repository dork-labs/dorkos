---
covers:
  - 'fix(rooms): a hand-off can be read by its id: pending and why, posted, or declined with the reason (DOR-3778)'
---

### Fixed

- When an agent's other chat hands a post to its chat in a room, that chat can now check how it went: still waiting and why, posted, or declined with the reason. Before, it heard nothing until the room chat answered, which could take an hour or never come.
