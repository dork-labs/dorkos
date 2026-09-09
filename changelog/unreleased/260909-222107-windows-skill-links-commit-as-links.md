---
covers:
  - 'fix(harness,server,cli): a real link where Windows allows one, and a warning where it does not (DOR-1883)'
  - 'fix(harness,cli): the Warnings heading names this run, and the link probe survives its own cleanup (DOR-1883)'
---

### Fixed

- On Windows, `dorkos harness sync` now makes real skill links whenever your account is allowed to — with Developer Mode on, or as an administrator. Before, it always made the one kind of link Windows allows without permission, and git commits a copy of every skill's files instead of the link, so a teammate who pulled got duplicated skills nobody meant to add (DOR-1883).
- If your account cannot make real links, DorkOS says so once per sync — in the terminal and on the Skills page — before you commit anything: what is on disk, what git would do with it, and the two ways out. Nothing is treated as broken, because the links still work on your own machine.
