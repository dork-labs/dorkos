---
covers:
  - 'fix(tasks): review permissions before row approval (DOR-3758)'
  - 'fix(tasks): make schedule review readable and enable package schedules'
  - 'fix(tasks): pin schedule reviews until explicitly refreshed'
---

### Fixed

- Review a schedule’s instructions and permissions before approving it from its row. Changed schedules need a fresh review (DOR-3758).

- Read long schedule instructions in one scrolling column. Reviewing a package switch offers approval that turns it on.

- A changed schedule stays blocked until you choose Review again. Background updates cannot silently replace an open review.
