---
covers:
  - 'feat(api): one event envelope and union for /api/events, with seq and Last-Event-ID replay (DOR-4986)'
  - 'feat(api): /api/events is documented as sent, replay counts bytes and rights at resume (DOR-4986)'
---

### Changed

- The app now picks up where it left off after a dropped connection. If it was offline only briefly, notices it missed can arrive late, right after it reconnects.
