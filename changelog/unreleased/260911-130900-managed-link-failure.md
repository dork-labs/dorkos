---
covers:
  - 'fix(connections): report missing hosted link before dispatch (DOR-1990)'
---

### Fixed

- When this instance loses its DorkOS account link, service actions now explain that nothing was sent and point to Settings to reconnect. Actions with an uncertain remote result remain protected from automatic retries.
