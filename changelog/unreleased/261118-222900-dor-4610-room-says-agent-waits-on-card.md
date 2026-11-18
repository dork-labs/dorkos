---
covers:
  - 'fix(rooms): a room says when an agent is waiting on your approval card (DOR-4610)'
  - 'fix(rooms): the waiting line points at the card when the card is in the room (DOR-4610)'
---

### Fixed

- When an agent in a room waits for you to approve one of its actions, such as a send through a
  connected app, the room now says so after a minute: who is waiting, where to answer, and that
  new messages for that agent wait with it. Before, the room showed only "working" and later
  "taking longer", so the agent seemed to go quiet.
