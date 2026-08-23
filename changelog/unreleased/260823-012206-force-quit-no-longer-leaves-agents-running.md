---
covers:
  - 'feat(server): a ledger of the warm agent processes this data directory owns (DOR-1310)'
  - 'fix(server): a force-quit no longer leaves warm agent processes running (DOR-1310)'
  - 'fix(server): the boot sweep must not let the event loop empty under it (DOR-1310)'
---

### Fixed

- If DorkOS is force-quit while it is keeping agents warm, the next start now cleans up the agents the old one left running. They no longer sit in the background using memory. Closing DorkOS the normal way already shut those agents down. It was the abrupt endings that did not, like force-quitting the app, a crash, or a hard restart. That mattered, because a dozen warm agents can hold on to several gigabytes between them. DorkOS only ends a process when it can prove it started that exact process itself, so nothing else on your machine is touched (DOR-1310).
