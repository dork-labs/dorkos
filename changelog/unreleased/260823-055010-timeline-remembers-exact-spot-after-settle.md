---
covers:
  - 'fix(client): the timeline remembers your exact spot after the view settles, not just on scroll (DOR-1431)'
---

### Fixed

- Coming back from a thread after scrolling up now lands you exactly where you were. The list quietly measures older messages a moment after you stop scrolling, and it used to remember your place from just before that — so returning could leave you a message off. It now waits for the view to settle before it remembers.
