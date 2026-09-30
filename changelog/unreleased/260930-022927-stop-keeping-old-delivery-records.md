---
covers:
  - 'perf(relay): keep delivery traces only while a message could still need them'
  - 'fix(community): delete used pairing requests an hour after they expire too'
  - 'fix(relay): keep connection events written before kind existed'
---

### Changed

- Stop keeping a record of every message delivery forever. The app now keeps a message's delivery record for eight days, as long as the message itself can still be waiting, and each connection's newest 500 events. On a busy install that keeps the database small, and a connection's event log and the delivery numbers load several times faster. (DOR-2574)
- Community servers now delete a connection request an hour after it expires, even once it was used. The connection it made stays. (DOR-2574)
