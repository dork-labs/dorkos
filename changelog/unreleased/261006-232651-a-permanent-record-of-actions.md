---
covers:
  - 'feat(audit): keep a permanent, checkable record of actions (DOR-2738)'
---

### Added

- DorkOS now keeps a permanent record of what happened on your computer: who did what, to what, and when, for you, your agents and DorkOS itself. Everything that shows in Activity goes into it, and nothing in DorkOS can change or remove a line once it is written. Anyone, you or any agent, can check that nobody edited it with `dorkos call audit.verify` (DOR-2738)

### Changed

- Activity now keeps a year of history instead of 30 days. Change it with `dorkos config set activity.retentionDays <days>` (DOR-2738)
