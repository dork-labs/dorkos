---
covers:
  - 'feat(usage): record Codex and OpenCode usage and limits (DOR-2380)'
  - 'fix(usage): keep same-millisecond OpenCode spend, and narrow the Codex limit match (DOR-2380)'
---

### Added

- DorkOS now records how much of your Codex plan you have used, read from what Codex already writes after each turn.
- DorkOS now records what your OpenCode turns cost each month. The total carries on after a restart and starts again on the first of each month.
- When Codex runs out of usage, or an OpenCode provider stops you for sending too much or for running out of credit, the session now shows it is waiting on a limit, and you get one notification about it instead of an error.
