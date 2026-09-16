---
covers:
  - 'fix(tasks): unregistering an agent pauses its schedules instead of switching them off (DOR-2082)'
---

### Fixed

- Unregistering an agent no longer switches off the schedules it owns. It pauses them instead — the same way a package update already worked — so a schedule you had approved and switched on comes back switched on and running once the agent is registered again (DOR-2082)
