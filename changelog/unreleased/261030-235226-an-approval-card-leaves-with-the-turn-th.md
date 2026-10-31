---
covers:
  - 'fix(server): an approval card leaves with the turn that failed under it (DOR-3210)'
---

### Fixed

- When an agent's turn fails while it is waiting for your approval, the approval card now closes with it. Before, the card stayed open with a working Approve button that did nothing, and the room kept showing the agent as waiting on you.
