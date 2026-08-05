---
covers:
  - 'fix(client): durable streams ride WebSockets so several windows stay responsive (DOR-927)'
---

### Fixed

- You can keep several DorkOS windows open at once. Opening a third window used to make
  the whole app stop responding — activity dots froze, replies looked stuck halfway,
  reloads never finished, and a fourth window would not open at all. Those were all one
  problem, and it is fixed (DOR-927)
