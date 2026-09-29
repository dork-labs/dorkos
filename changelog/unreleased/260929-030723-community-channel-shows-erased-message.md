---
covers:
  - 'fix(communities): update an open Community channel when a message is deleted or erased (DOR-2544)'
  - 'fix(communities): keep changed messages across a reconnect, and poll the feed gently (DOR-2544 review)'
---

### Fixed

- An open Community channel now updates when a message in it is deleted, removed or erased. Within about 30 seconds the message changes to its "deleted" or "erased" note right where it sits, including in an open thread, and the reply count under it stays. You don't need to reload, and a change made while the channel was reconnecting still arrives. Before, the old words stayed on screen until you left the channel and came back.
