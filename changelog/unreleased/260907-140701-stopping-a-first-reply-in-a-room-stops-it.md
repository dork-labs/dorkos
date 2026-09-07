---
covers:
  - "fix(server): stopping an agent's very first reply in a room now stops it (DOR-1721)"
  - 'fix(server): the boot-window stop re-aims at the turn, not at what it reached (DOR-1721 review)'
  - 'fix(server): the boot-window stop is marked on the turn, under either of its names (DOR-1721 review 2)'
---

### Fixed

- Stopping an agent's very first reply in a room now always stops it. The very first time an agent answers in a room, DorkOS works out which program is running that answer by reading the agent's settings — and if those settings changed while the answer was being written, Stop went to the wrong program and quietly did nothing: the reply carried on to the end, and you paid for it. DorkOS now remembers which program picked the answer up, so Stop goes there (DOR-1721)
