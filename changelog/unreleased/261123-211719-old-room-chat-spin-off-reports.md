---
covers:
  - 'fix(rooms): a spin-off started from an old room chat no longer wakes the agent in the room (DOR-3753)'
  - 'fix(rooms): a spin-off started from an old room chat is not promised reports that cannot arrive (DOR-3753)'
---

### Fixed

- When an agent's room chat had moved to a fresh chat, and you reopened the old one and started a spin-off chat from there, that spin-off's report went to the agent in the room instead. Now it doesn't: the spin-off isn't told its reports will reach anyone, and if one is made anyway you get a note that it couldn't be delivered. Spin-offs started before the move still report to the agent in the room (DOR-3753).
