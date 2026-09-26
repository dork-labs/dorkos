---
covers:
  - 'fix(tasks): keep schedules running after a failed lock write on a full disk (DOR-2131, DOR-2132)'
  - 'fix(tasks): only clean up a half-written scheduler lock that is still ours (DOR-2131)'
---

### Fixed

- Scheduled tasks no longer stop for good after the disk fills up. A write that failed partway could leave a broken lock file behind, and from then on no scheduled task ran, with nothing in the log to say why. DorkOS now replaces a broken lock file and cleans up after its own failed writes (DOR-2131)
- A second full-disk spell now shows up in the log too, not only the first (DOR-2132)
