---
covers:
  - "fix(server): a restart no longer leaves a chat's old agent process running beside the new one (DOR-3049)"
---

### Fixed

- After DorkOS restarts, a chat runs one agent process again. On a busy machine an agent process could go unrecorded, or a restart could start before the previous server had fully exited, and then the old process kept running beside the one the restart woke for the same chat. DorkOS now records every agent process it starts, and a restart waits for the previous server to finish exiting before it ends what that server left running.
