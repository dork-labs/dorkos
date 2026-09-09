---
covers:
  - 'feat(server): keep Connections available during long agent turns (DOR-1903)'
---

### Changed

- Connections now stay available while Claude Code, Codex, or OpenCode keeps the same long-running turn active. Ending the turn closes access. If supervision stops unexpectedly, that access still expires within four hours.
