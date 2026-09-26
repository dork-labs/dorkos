---
covers:
  - "fix(relay): stop agents from sending to DorkOS's own relay addresses (DOR-2432)"
---

### Security

- Agents can no longer send messages to DorkOS's own internal addresses, the ones it uses to start scheduled tasks, answer approval requests and stop runs. Only DorkOS itself can send there now, so an agent can't pretend to be the scheduler or approve its own tool calls. Agents still message each other and reach you exactly as before (DOR-2432).
