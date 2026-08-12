---
covers:
  - 'fix(client): queued messages keep the order you typed them (DOR-1165)'
---

### Fixed

- Line up several messages while an agent is still working and they now stay in the
  order you typed them. Each one is sent to the queue as its own request, and a slow
  network could let a later message land ahead of an earlier one — so a fast typist,
  or a paste-and-Enter flurry, could see two messages swap places. The requests are
  now sent one after another, so the queue always matches what you typed.
