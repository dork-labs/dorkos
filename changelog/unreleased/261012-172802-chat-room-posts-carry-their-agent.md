---
covers:
  - 'fix(rooms): a chat posts in a room as its agent, never as you (DOR-2863)'
  - 'fix(rooms): a bound chat keeps its recorded agent, and test the first send (DOR-2863)'
---

### Fixed

- A chat an agent started in a folder of its own now posts in channels under that agent's name. Before, those posts were saved under your name, so they could look like your approval
- A chat with no agent behind it can no longer post, react or act in channels as you. It is refused instead
