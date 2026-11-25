---
covers:
  - 'fix(runtimes): an agent working outside its home gets its own skills in the / menu (DOR-5250)'
---

### Fixed

- An agent you send to work in a project folder now shows its own skills in the `/` menu, and you can run them. Before, the menu only had the folder's skills, and Claude Code answered "Unknown command" for the agent's own. This works on Claude Code and Codex. When the folder has a skill with the same name, the folder's skill is the one you get.
