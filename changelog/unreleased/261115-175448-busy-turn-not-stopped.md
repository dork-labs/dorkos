---
covers:
  - 'fix(claude-code): a turn still working four hours in is never closed mid-work (DOR-2705)'
  - 'fix(claude-code): a turn ends at a 16-hour limit, and only the agent itself counts as working (DOR-2705)'
  - 'fix(claude-code): a chain of agent-started turns also ends at 16 hours of nonstop work (DOR-2705)'
---

### Fixed

- An agent still working on a long task is no longer stopped after about four hours with "DorkOS closed the agent before it finished this turn". (DOR-2705)
- An agent can now work nonstop for up to 16 hours, so one stuck in a loop still stops the same day. (DOR-2705)
- When DorkOS closes an agent mid-turn, the message says why: DorkOS shut down, the agent sent nothing for four hours, or it hit the 16-hour limit. (DOR-2705)
