---
covers:
  - "fix(cli): give community setup's slow steps the time they really take, and recover a cut-off deploy (DOR-2169)"
---

### Fixed

- Setting up your own community with `dorkos community deploy` no longer gives up while Fly is still starting it. Setup allowed every step 30 seconds, but starting your community can take longer, and cutting it off left setup unsure whether it had worked. Starting and restarting now get up to ten minutes, and creating or removing things gets two. If a start is still cut off, running the same command with `--resume` starts it again instead of stopping (DOR-2169)
