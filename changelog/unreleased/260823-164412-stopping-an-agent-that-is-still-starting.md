---
covers:
  - 'fix(server): stopping an agent that is still starting up really stops it (DOR-1424)'
---

### Fixed

- Stop now reaches an agent that is still starting up. Pressing Stop in the first
  moments of a turn used to stop nothing: the agent finished the whole answer
  anyway, and you paid for it. (DOR-1424)
