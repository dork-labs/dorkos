---
covers:
  - 'fix(rooms): a spin-off started from an old room chat reports back to that chat (DOR-3753)'
---

### Fixed

- When an agent's room chat had moved to a fresh chat and you reopened the old one, a spin-off chat you started from there didn't report back to it. Now its reports come back into that old chat, the same way a spin-off reports to any chat that started it. Spin-offs started before the move still report to the agent in the room (DOR-3753).
