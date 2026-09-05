---
covers:
  - 'fix(relay): an expired envelope is refused at every seam (DOR-1770)'
---

### Fixed

- A message that ran out of time before an agent saw it is now turned away everywhere, and the sender is told so. One path already refused it; another quietly handed it a fresh full clock and answered as if it had just arrived — so an hour-old message could still start a turn nobody was waiting for (DOR-1770)
