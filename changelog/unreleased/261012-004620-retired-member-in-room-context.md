---
covers:
  - 'fix(rooms): agents read a retired member as retired, not as an ordinary member (DOR-2364)'
---

### Fixed

- In a direct message that still lists a removed agent, the other agents are now told it is retired and will not reply, so they stop waiting on it. The app already showed it that way.
