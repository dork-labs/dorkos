---
covers:
  - 'perf(client): a long chat stays smooth while a reply streams (DOR-2895)'
---

### Changed

- A long chat stays smooth while the agent is replying. Before, every new word redrew every message on screen and rebuilt the whole history. Now only the reply being written redraws, and the history is prepared once.
