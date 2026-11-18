---
covers:
  - 'fix(extensions): mini app data is kept from agents, and a person’s actions are recorded by DorkOS (DOR-4301)'
  - 'fix(extensions): a mini app checks a person’s action against DorkOS’s own record (DOR-4301)'
  - 'fix(extensions): work a person’s request hands to an agent never records as the person (DOR-4301)'
---

### Fixed

- Mini apps can now ask DorkOS to record something you did while signed in, and check it later. DorkOS keeps that record itself, outside the mini app's data, so a mini app can tell a comment you wrote from one an agent wrote (DOR-4301)
