---
covers:
  - "fix(server): a queued message's turn is logged under its own id (DOR-1159)"
---

### Fixed

- Server logs now show which message each turn belongs to on a busy session. Messages you
  sent while an agent was still working were being logged under the id of the turn ahead of
  them, so a log from a busy session ran everything together and there was no way to tell
  where one turn ended and the next began (DOR-1159)
