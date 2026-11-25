---
covers:
  - 'fix(runtimes): an agent working outside its home still knows its own skills'
  - 'fix(runtimes): list no home skills when the caller gives no working folder'
---

### Fixed

- An agent you send to work in a project folder still knows its own skills. Before, it only saw the skills in that folder. This works on Claude Code, Codex and OpenCode. Doe already did this.
