---
covers:
  - 'fix(server): one probe answers whether a room still has its conversation (DOR-805)'
---

### Fixed

- The health check now spots a room that can no longer find its conversation after its agent's folder moved. It used to look for the saved conversation anywhere on disk and call the room healthy, while the agent itself looked only where it lives now and started over from nothing every time (DOR-805)
