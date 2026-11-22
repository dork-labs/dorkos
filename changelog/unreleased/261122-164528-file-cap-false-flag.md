---
covers:
  - 'fix(tasks): an unchanged instructions file never caps a scheduled task (DOR-5060)'
---

### Fixed

- Scheduled tasks no longer lose their permissions when their instructions file hasn't changed. Extra spaces at line ends, line-ending style and extra blank lines no longer count as a change. A task waiting on its file now has a Review file button, so you can approve the file as it is (DOR-5060).
