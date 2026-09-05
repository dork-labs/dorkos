---
covers:
  - 'fix(relay): the mailbox watcher sweeps what arrived before it was ready (DOR-1787)'
---

### Fixed

- Messages sent to an agent while its mailbox was still starting up are no longer missed. DorkOS now re-reads the mailbox as soon as it starts watching it, so a message that landed a moment too early — or while DorkOS was not running at all — is delivered instead of sitting there unnoticed (DOR-1787)
