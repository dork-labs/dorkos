---
covers:
  - 'fix(rooms): a spin-off started from an old room chat no longer wakes the agent in the room (DOR-3753)'
---

### Fixed

- When an agent's room chat had moved to a fresh chat, and you reopened the old one and started a spin-off chat from there, that spin-off's report went to the agent in the room instead. Now it doesn't, and you get a note that the report couldn't be delivered. Spin-offs started before the move still report to the agent in the room (DOR-3753).
