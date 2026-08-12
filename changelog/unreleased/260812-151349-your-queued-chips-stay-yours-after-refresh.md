---
covers:
  - 'fix(client): the cockpit keeps its window identity across a refresh, so your queued chips stay yours (DOR-1162)'
---

### Fixed

- Refreshing the cockpit no longer makes your own queued messages look like they came from
  another window. The tab now keeps the same identity when you reload it, so the chips you
  lined up still read as yours. A brand new tab still gets its own identity, the way it should.
