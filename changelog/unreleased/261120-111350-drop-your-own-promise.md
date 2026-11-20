---
covers:
  - 'fix(todos): a person can drop their own promise, and promises they add are saved as theirs (DOR-3832)'
  - 'fix(todos): count a person with no owner account as the person only at this computer (DOR-3832)'
  - 'fix(todos): tighten the promise drop tests and owner lookup notes (DOR-3832)'
---

### Fixed

- Drop now works on a promise you added, when you're signed in or on the computer DorkOS runs on with no account set up. Before, it said "Try again" however often you tried (DOR-3832)
- On the computer DorkOS runs on, with no account set up, your agent now treats promises you add as yours, not a stranger's (DOR-3832)
