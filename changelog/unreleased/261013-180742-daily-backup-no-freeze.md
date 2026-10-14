---
covers:
  - 'perf(server): take the daily database backup without freezing the app (DOR-2906)'
---

### Fixed

- DorkOS no longer pauses for a moment once a day while it saves its daily backup of your data. It now copies the database a little at a time and keeps answering in between (DOR-2906)
