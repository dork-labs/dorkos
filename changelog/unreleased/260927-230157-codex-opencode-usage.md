---
covers:
  - 'feat(usage): record Codex and OpenCode usage and limits (DOR-2380)'
---

### Added

- DorkOS now keeps track of how much of your Codex plan you have used, read from what Codex already writes after each turn.
- For OpenCode, DorkOS adds up what each turn costs, so you can see what you spent this month. The total carries on after a restart and starts again on the first of each month.
- When Codex runs out of usage, or an OpenCode provider stops you for sending too much or for running out of credit, the session now shows it is waiting on a limit, and you get one notification about it instead of an error.
