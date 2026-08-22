---
covers:
  - 'feat(db): a table for staged words the runtime could not take (DOR-1324)'
  - 'fix(server): context you add for an agent survives a restart (DOR-1324)'
  - 'fix(server): a reaped process is not an adapter bug, and a swept session keeps no words (DOR-1325)'
---

### Fixed

- Context you add for an agent now survives a DorkOS restart. The note that says it was added is never left pointing at words that vanished — they are saved the moment you add them, and the agent gets them with your next message (DOR-1324).
- Cleaned up a false alarm in the server log: when an agent's background process was tidied up at the exact moment you added context, DorkOS logged it as a fault. It was normal, your words were kept, and it is no longer reported as a problem (DOR-1325).
