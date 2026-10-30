---
covers:
  - 'fix(client): a chat gets live updates back on its own after DorkOS restarts (DOR-3482)'
---

### Fixed

- When DorkOS stops and starts again, an open chat now gets its live updates back on its own, like a room does. Before, it kept saying "Live updates lost" until you sent a message or reloaded the page.
