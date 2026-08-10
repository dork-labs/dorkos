---
covers:
  - 'fix(client,server): the Activity week line counts the same machine the feed describes (DOR-1039)'
---

### Fixed

- The line above your Activity feed now counts sessions your agents started across
  your whole machine, which is the same ground the feed below it covers. It used to
  count only the project you happened to have open, so the two quietly described
  different things. It also says plainly what it counts now — "Your agents started 12
  sessions this week" — and if a runtime can't be reached, it says "at least" instead
  of passing a smaller number off as the whole story (DOR-1039)
