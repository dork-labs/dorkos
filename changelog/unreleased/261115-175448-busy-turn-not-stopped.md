---
covers:
  - 'fix(claude-code): a turn still working four hours in is never closed mid-work (DOR-2705)'
---

### Fixed

- An agent that is still working on a long task is no longer stopped after about four hours with "DorkOS closed the agent before it finished this turn". (DOR-2705)
- When DorkOS does have to close an agent mid-turn, the message now says why: DorkOS shut down, or the agent went four hours without a word. (DOR-2705)
