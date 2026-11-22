---
covers:
  - 'fix(server): a spin-off waiting for a free agent slot is no longer reported as never started (DOR-4985)'
---

### Fixed

- When every agent on your computer is busy, a new chat that one agent starts for another waits in line for a turn. That wait used to count against its five-minute start limit, so the agent that started it heard "never started" and often started a second copy. The wait no longer counts. If a chat was already reported as never started and then starts, the agent that started it now hears "started after all", once (DOR-4985)
