---
covers:
  - 'feat(api): one event envelope and union for /api/events, with seq and Last-Event-ID replay (DOR-4986)'
---

### Changed

- The live update stream now picks up where it left off after a dropped connection. If it was down only briefly, the app gets the updates it missed instead of starting over.
