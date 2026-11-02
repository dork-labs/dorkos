---
covers:
  - 'fix(tasks): a revoked agent token makes no schedule that starts by itself (DOR-3666)'
---

### Fixed

- An agent whose access you've switched off can no longer make a scheduled task that starts without asking you. A task it asks for waits for your approval, and DorkOS doesn't credit it to that agent.
