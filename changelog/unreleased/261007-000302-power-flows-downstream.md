---
covers:
  - 'fix(trust): a turn another agent or a stranger starts runs no looser than its sender (DOR-2739)'
---

### Fixed

- A message from a stranger can no longer get one of your agents to work at the power level you set for yourself. That covers someone in a bridged Telegram or Slack chat, or another company's agent. The agent answers at the level a brand-new chat starts at, even in a conversation set to Full autonomy, and even when the message reaches it through another agent. Your own next message runs at the level you chose (DOR-2739)
- When one of your agents asks another for help in a room, the second agent works with no more power than the first one had at that moment (DOR-2739)
