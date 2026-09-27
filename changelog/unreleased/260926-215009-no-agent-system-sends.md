---
covers:
  - "fix(relay): stop agents from sending to DorkOS's own relay addresses (DOR-2432)"
  - 'fix(relay): let only DorkOS itself reach its relay addresses, and refuse webhooks aimed at them (DOR-2432)'
  - 'fix(relay): drop the pre-DOR-2431 chat approval senders from the server-sender allowlist (DOR-2432)'
---

### Security

- Agents can no longer send messages to DorkOS's own internal addresses, the ones it uses to start scheduled tasks, answer approval requests and stop runs. Only DorkOS itself can send there now, so an agent can't pretend to be the scheduler or approve its own tool calls. A webhook can't be set up to deliver to those addresses either. Agents still message each other and reach you exactly as before (DOR-2432).
