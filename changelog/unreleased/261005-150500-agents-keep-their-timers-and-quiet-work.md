---
covers:
  - 'fix(claude-code): hold a chat for its pending timers, and let any quiet background task keep its turn'
  - 'fix(claude-code): let timer-only chats give way under a full warm ceiling, and keep shells out of the stall pause (DOR-2717)'
---

### Fixed

- A reminder an agent sets for itself (a wake-up or a scheduled prompt in the chat) now fires. Before, the agent was closed five minutes after its turn and the reminder was lost.
- A turn waiting on a Monitor, a workflow or a background tool no longer gets stopped after ten quiet minutes.
