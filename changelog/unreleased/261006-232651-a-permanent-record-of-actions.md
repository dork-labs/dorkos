---
covers:
  - 'feat(audit): keep a permanent, checkable record of actions (DOR-2738)'
  - 'fix(audit): stronger redaction, bounded verify, honest tamper claims (DOR-2738)'
  - 'fix(audit): linear redaction and gap-proof verify paging (DOR-2738)'
  - 'fix(audit): redact secrets in URLs again (DOR-2738)'
---

### Added

- DorkOS now keeps a permanent record of what happened on your computer: who did what, to what, and when, for you, your agents and DorkOS itself. Everything that shows in Activity goes into it, and nothing in DorkOS can change or remove a line once it is written. Anyone, you or any agent, can check it with `dorkos call audit.verify`, which names the first line that was changed or taken out of the middle. Lines taken off the end can't be caught yet (DOR-2738)

### Changed

- Activity now keeps a year of history instead of 30 days. Change it with `dorkos config set activity.retentionDays <days>`; the new number applies the next time DorkOS starts (DOR-2738)
