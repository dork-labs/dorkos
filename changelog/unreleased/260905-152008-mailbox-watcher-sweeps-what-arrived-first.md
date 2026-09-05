---
covers:
  - 'fix(relay): the mailbox watcher sweeps what arrived before it was ready (DOR-1787)'
  - 'refactor(relay): the sweep drains a backlog one message at a time (DOR-1787)'
---

### Fixed

- DorkOS now re-reads a message mailbox the moment it starts watching it, instead of only reacting to what arrives afterwards. Anything already waiting — mail that landed while DorkOS was not running, or in the instant the watcher was still starting up — is picked up straight away rather than sitting there until something else happens to arrive (DOR-1787)
