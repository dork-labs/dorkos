---
covers:
  - 'fix(client): a slow start is no longer announced as a failed one (DOR-1771)'
---

### Fixed

- DorkOS sometimes said "DorkOS couldn't finish starting" on a machine that was
  simply busy. One small hiccup while the app was still loading — a picture that
  didn't arrive, a request that gave up — was enough to make it announce a
  failure, even though the app came up seconds later. It now waits until loading
  has actually stopped before saying anything went wrong, so a slow start looks
  like a slow start.
- When starting really does fail, the details behind that message are also
  written to the browser's log. They used to live only inside a collapsed
  "Technical details" block, where automated tools couldn't see them — so a
  failure could be spotted without anyone learning what caused it.
