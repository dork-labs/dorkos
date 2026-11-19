---
covers:
  - 'fix(runtimes): automatic account picks skip a signed-out account (DOR-4439)'
---

### Fixed

- When DorkOS picks a Claude account by itself, it no longer picks one that is signed out. That
  covers moving an agent off a full account, starting a new chat, and the work queue. You can still
  choose a signed-out account yourself, and DorkOS tells you it is signed out. A work queue that
  waits for that reason now says so (DOR-4439).
