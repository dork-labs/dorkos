---
covers:
  - 'perf(server): the five-minute task check writes only what changed (DOR-2899)'
---

### Fixed

- DorkOS does less busywork in the background. Every five minutes it checked all your scheduled tasks against their files, and rewrote every one of them and reset its timer, even when nothing had changed. Now it only touches a task whose file changed, or whose timer had gone missing (DOR-2899)
