---
covers:
  - 'fix(connections): finish a DorkOS-account disconnect even when the confirmation stalls, and say why it is waiting (DOR-2468)'
  - 'fix(connections): say when a disconnect was refused, and finish a stalled resume the same way (DOR-2468)'
  - 'fix(connections): let the stored state take over from a refused try, and give retry reasons only to changes DorkOS resends (DOR-2468)'
---

### Fixed

- Disconnecting an app that goes through your DorkOS account now finishes on its own even when disconnecting stalls partway. DorkOS keeps trying, waiting a little longer between tries, until it is done, instead of waiting forever for an answer that would never come (DOR-2468)
- **Finish disconnecting** no longer seems to do nothing. When disconnecting is still going, the panel says so, says why it is waiting (for example, that DorkOS's servers had a problem) and when it will try again, and keeps itself up to date until it is done. You can still ask for a try right away (DOR-2468)
- Apps disconnected before DorkOS tracked this now finish disconnecting the same way (DOR-2468)
- When DorkOS can't finish disconnecting on its own (for example, this instance is no longer linked), the panel says why and offers **Try disconnecting again** (DOR-2468)
- Resuming a paused app that goes through your DorkOS account no longer waits forever when the first answer stalls; DorkOS asks again until it goes through (DOR-2468)
