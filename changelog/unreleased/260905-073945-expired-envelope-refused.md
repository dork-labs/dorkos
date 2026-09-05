---
covers:
  - 'fix(relay): an expired envelope is refused at every seam (DOR-1770)'
  - 'fix(relay): one clock reading decides an expired envelope (DOR-1770)'
---

### Fixed

- A message that ran out of time before an agent saw it is now turned away everywhere, and whoever sent it is told in plain words — "The message expired before the agent could start" — instead of "TTL budget expired". One path already refused these; another quietly handed the message a fresh full clock and answered as if it had just arrived, so an hour-old message could still start a turn nobody was waiting for (DOR-1770)
