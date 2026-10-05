---
covers:
  - 'fix(claude-code): hold a chat for its pending timers, and let any quiet background task keep its turn'
---

### Fixed

- A reminder an agent sets for itself (a wake-up or a scheduled prompt in the chat) now fires. Before, the agent was closed five minutes after its turn and the reminder was lost.
- A turn waiting on a Monitor, a workflow or a background tool no longer gets stopped after ten quiet minutes.
