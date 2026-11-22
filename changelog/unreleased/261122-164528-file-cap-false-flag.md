---
covers:
  - 'fix(tasks): an unchanged instructions file never caps a scheduled task (DOR-5060)'
  - 'fix(shared): export TaskFileReview from the types entry (DOR-5060)'
  - 'fix(approvals): every invisible character shows in what a person approves (DOR-5060)'
---

### Fixed

- Scheduled tasks no longer lose their permissions when their instructions file hasn't changed. Extra spaces at line ends, line-ending style and extra blank lines no longer count as a change. A task waiting on its file now has a Review file button, so you can approve the file as it is (DOR-5060).
- Invisible characters in text you approve, like a scheduled task's instructions or a package's commands, now always show as visible codes (DOR-5060).
