---
covers:
  - 'fix(server): a tool argument with a default may be left out again (DOR-2053)'
---

### Fixed

- An agent asking DorkOS what it can do no longer gets an error when it leaves the page size out. Nine tools had an argument you were supposed to be able to skip — the page size on activity, room history, room search and marketplace search, and the member list when creating a room — and skipping it failed the call instead of filling in the usual value (DOR-2053)
