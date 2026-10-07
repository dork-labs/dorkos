---
covers:
  - 'fix(trust): a turn another agent or a stranger starts runs no looser than its sender (DOR-2739)'
  - 'fix(trust): close the review gaps in power flowing downstream (DOR-2739)'
---

### Fixed

- A message from someone in a bridged Telegram or Slack chat in a room, or from another company's agent, now gets an answer at the level a brand-new chat starts at. That holds even in a conversation you set to Full autonomy, and when such a message arrives in the same moment as yours. Your own next message runs at the level you chose (DOR-2739)
- When one of your agents asks another for help in a room, the second agent works with no more power than the first one had at that moment (DOR-2739)
