---
covers:
  - 'perf(server): back off when DorkOS Cloud keeps refusing (DOR-2903)'
---

### Fixed

- When DorkOS Cloud is down or doesn't recognize your computer, DorkOS now waits longer between tries, up to 5 minutes for new events and 30 minutes for credits, instead of asking every 30 or 60 seconds for hours and filling the log with the same warning. It goes back to asking often as soon as a try works or you link again (DOR-2903)
