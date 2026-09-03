---
covers:
  - 'fix(server): a scheduled run reads live adapter state before using the bus (DOR-1636)'
---

### Fixed

- Fixed scheduled runs failing with "No receiver for the scheduled run" when the agent-messaging connection they were handed to was switched off or had failed to start. DorkOS now checks that something is really listening before it hands a run over, and simply runs it itself when nothing is (DOR-1636)
