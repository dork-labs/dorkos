---
covers:
  - 'fix(server): stopping an agent gives you your composer back sooner (DOR-1319)'
---

### Fixed

- Stopping an agent gives you the composer back sooner. A stopped turn used to spend up to eight more seconds asking the agent for its context and usage numbers after the work had already halted, so the screen looked live while nothing was happening. Those numbers now refresh on your next turn instead (DOR-1319)
