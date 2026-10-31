---
covers:
  - 'fix(server): a message that hit a usage limit no longer says delivered (DOR-3287)'
---

### Fixed

- When an agent sends a message to a chat whose account is out of usage, or that can't reach the API, the sender now sees that the message wasn't answered and why. Before, it said "delivered" even though the other agent hadn't read it, sometimes for days.
