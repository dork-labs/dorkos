---
covers:
  - 'feat(marketplace): show what a package will run before you install it (DOR-635)'
---

### Added

- See the exact commands a package will run on your machine before you install it. The install preview now lists each one, word for word, next to the moment it fires (DOR-635)
- See the jobs a package will schedule, when they run, whether they start switched on, and how much each one may do without asking you. Shapes used to create timed jobs that no preview mentioned at all (DOR-635)

### Changed

- The install preview describes what a scheduled job may do in plain words, like "can run any command without asking you", instead of showing a setting name only a developer would recognise (DOR-635)
- If a package declares commands in a form DorkOS cannot read, the preview says so. It used to show nothing, which looked exactly like a package that runs no commands (DOR-635)
