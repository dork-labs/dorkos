---
covers:
  - 'feat(heartbeats): a beat wakes an agent whose lanes or open promises went quiet, naming each (DOR-3674)'
---

### Added

- An agent's heartbeat now notices work that went quiet. If a chat the agent started has done nothing for 2 hours, or the agent has an open promise and no chat has run for 30 minutes, the next heartbeat wakes the agent and names each item and when it went quiet. The same stall wakes it at most twice. A paused agent, or one whose heartbeat is off, is never woken.
