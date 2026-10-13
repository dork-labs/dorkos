---
covers:
  - 'fix(server): a Codex chat in an agent folder answers instead of failing every turn (DOR-2752)'
  - 'fix(server): only a chat with no recorded agent runs without connected apps; OpenCode too (DOR-2752)'
---

### Fixed

- A Codex or OpenCode chat started in an agent's folder now answers. Before, every message failed with "couldn't confirm this chat can use connected apps", and trying again never helped. When a chat has no recorded agent, it runs without connected apps instead.
