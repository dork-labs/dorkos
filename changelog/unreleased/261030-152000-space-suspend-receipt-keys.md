---
covers:
  - 'fix(spaces): suspending a space never trips over a join receipt'
---

### Fixed

- Suspending or archiving a space could fail with "The space is unavailable" on a small number of servers, every time, once someone had joined by invite. It now works on all of them.
