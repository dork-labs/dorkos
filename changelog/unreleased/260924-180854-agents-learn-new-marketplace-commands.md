---
covers:
  - 'feat(operating-skills): teach agents the new marketplace commands, what updates keep, held-back packages and package schedule timing (DOR-2305)'
---

### Changed

- Your agents now know how the marketplace and schedules work today. They can list what is installed and what is out of date, and they tell you when an update saved your edited copy of a file beside the new one. They know a package held back from your sessions waits for you, and they can't approve it themselves. They also know that changing a schedule's timezone needs your approval again, and that a schedule that came with a package can only be switched on or off or given a new time (DOR-2305)
- `dorkos marketplace install --help` now lists `--approval`, and `dorkos marketplace held-back --help` says a decision covers the installed copy (DOR-2305)
