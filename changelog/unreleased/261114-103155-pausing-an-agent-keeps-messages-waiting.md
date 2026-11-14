---
covers:
  - 'fix(session): pausing an agent holds the messages queued for it, and resuming runs each once (DOR-4327)'
---

### Fixed

- Pausing an agent no longer throws away a message another agent had waiting for it. The message waits while the agent is paused, and runs once when you resume it.
