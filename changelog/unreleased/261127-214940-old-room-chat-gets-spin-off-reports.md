---
covers:
  - 'fix(rooms): a spin-off started from an old room chat reports back to that chat (DOR-3753)'
  - 'fix(rooms): reports to an old room chat survive a full launch queue and an agent leaving the room (DOR-3753)'
---

### Fixed

- When an agent's room chat had moved to a fresh chat and you reopened the old one, spin-offs the agent started from there didn't report back to it. Now their reports come back into that old chat, like any spin-off's. Spin-offs started before the move still report to the agent in the room. And when an agent leaves a room, or leaves and comes back, reports from work it started there now come back to its old chat instead of showing as undelivered in your Inbox (DOR-3753).
