---
covers:
  - 'fix(chat): answers to a scheduled run reach the agent that asked'
---

### Fixed

- When an agent asks another chat something during a scheduled run or a heartbeat, the answer now reaches it. It arrives in that agent's direct chat with whoever answered, instead of being refused.
