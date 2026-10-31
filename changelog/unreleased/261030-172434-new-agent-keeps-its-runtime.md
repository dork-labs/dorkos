---
covers:
  - 'fix(server): a new Codex or OpenCode agent runs on the runtime its person picked (DOR-3459)'
---

### Fixed

- A new agent you set to Codex or OpenCode now runs on Codex or OpenCode from its first chat. Before, it quietly ran on Claude Code instead, and could bill the wrong account. If an agent ever can't run on the runtime it is set to, its chat now says so.
