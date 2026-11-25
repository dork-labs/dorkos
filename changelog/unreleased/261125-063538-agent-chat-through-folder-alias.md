---
covers:
  - "fix(agents): start an agent's chat when its folder is reached through a symlink (DOR-5117)"
---

### Fixed

- A new agent's first chat now starts, and the agent says hello, when your DorkOS folder or the agent's folder is reached through a shortcut such as a symlink. Before, the app refused the greeting because it saw two spellings of one folder as two folders (DOR-5117)
