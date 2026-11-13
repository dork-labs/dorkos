---
covers:
  - 'fix(runtimes): queued notes and other context read the same on every runtime (DOR-3604)'
---

### Fixed

- A message you queue while an agent is busy, plus its git status, its setup details and a relayed message's details, now reach Codex, OpenCode and DorkOS (built-in) agents as plain text. Before, those agents got raw JSON. Claude Code agents already read them this way. (DOR-3604)
