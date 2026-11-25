---
covers:
  - 'fix(runtimes): an empty agent reply says so on every runtime (DOR-3606)'
---

### Fixed

- When an agent's reply comes back empty, or with nothing but blank space, the chat now tells you the agent did not respond. This works on Codex and OpenCode as well as Claude Code. Before, a Codex or OpenCode reply could just stop with nothing in it and no reason.
