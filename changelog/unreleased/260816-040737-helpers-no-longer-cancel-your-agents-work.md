---
covers:
  - 'fix(server): hold the CLI stdin open while a background subagent is still live (DOR-1238)'
---

### Fixed

- Your agent no longer loses file writes when a helper is still running. Before this, a helper finishing at the wrong moment could leave the agent watching its own writes get cancelled, and reading that as you saying no — you hadn't. Turns that use helpers also finish as soon as the work is done, instead of sitting there for another half a minute (DOR-1238)
