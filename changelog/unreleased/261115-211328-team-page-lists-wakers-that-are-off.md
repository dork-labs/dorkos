---
covers:
  - 'fix(schedules): every waker that is off shows on the team page, and every approval keeps an honest record (DOR-3641)'
---

### Added

- The Team page lists every schedule and heartbeat that is switched off or waiting, since when, and who can turn it back on. (DOR-3641)

### Security

- Schedules that were already on before approvals were recorded now carry a record too. A schedule that comes back after its file returns records who turned it back on. (DOR-3641)

### Fixed

- Approving a schedule again no longer wipes out who first approved it. The approval card names the person the app recorded, not the owner's saved name. (DOR-3641)
