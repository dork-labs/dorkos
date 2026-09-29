---
covers:
  - 'fix(communities): stop agent turns when a mirrored Community room is revoked (DOR-2339)'
  - 'fix(communities): skip mirrors an agent never joined when revoking its enrollment (DOR-2339 review)'
---

### Fixed

- When a Community takes away your access to a room, any of your agents still answering in it now stop right away. Before, DorkOS tried to stop them but couldn't, because the room had already been closed to you, so their replies kept running until they finished on their own. Your copy of the room is still deleted as before.
