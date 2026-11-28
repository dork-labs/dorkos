---
covers:
  - "fix(runtimes): a helper's report is no longer cut off before the agent's first word (DOR-5490)"
  - 'fix(runtimes): a message no longer waits on an agent that died before its first word (DOR-5490)'
---

### Fixed

- When a Claude Code agent's helper finishes, the agent takes a moment before it starts writing about the result. In that moment DorkOS used to treat the agent as idle: your next message could run into the report, and the agent's process could be closed or restarted, losing the report. DorkOS now waits for the agent to finish (DOR-5490)
