---
covers:
  - 'fix(server): a Codex chat in an agent folder answers instead of failing every turn (DOR-2752)'
---

### Fixed

- A Codex chat started in an agent's folder answers again. Before, every message failed with "couldn't confirm this chat can use connected apps", and trying again never helped. If DorkOS can't confirm which agent the chat belongs to, the chat now runs without connected apps.
