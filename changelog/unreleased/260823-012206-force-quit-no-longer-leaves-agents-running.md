---
covers:
  - 'feat(server): a ledger of the warm agent processes this data directory owns (DOR-1310)'
  - 'fix(server): a force-quit no longer leaves warm agent processes running (DOR-1310)'
---

### Fixed

- If DorkOS is force-quit while it is keeping agents warm, the next start now cleans up the agents the old one left running — they no longer sit in the background using memory. Closing DorkOS normally already shut them down; it was the abrupt endings that didn't, like force-quitting the app, a crash, or a hard restart, and a dozen warm agents can hold on to several gigabytes between them. DorkOS only ever ends processes it can prove it started itself, so nothing else on your machine is touched (DOR-1310).
