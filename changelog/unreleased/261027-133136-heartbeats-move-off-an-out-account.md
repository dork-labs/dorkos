---
covers:
  - 'fix(heartbeats): an agent keeps waking when its account runs out'
---

### Fixed

- An agent's heartbeat keeps working when its Claude account runs out. It moves to another account with usage left. If none has any, it waits for the reset instead of failing again and again.
