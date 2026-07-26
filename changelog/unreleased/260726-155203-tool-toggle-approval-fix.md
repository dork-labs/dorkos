---
covers:
  - "fix(security): tool-group toggles no longer widen an agent's auto-approval (DOR-519)"
---

### Fixed

- Turning off a group of tools for an agent did the opposite of what it looked like. Instead of holding those tools back, it stopped up to 24 other DorkOS tools from asking you first. Deleting a chat route and switching off a connected channel like Slack were both in that set. The two riskiest actions, deleting a scheduled task and removing an agent, were never exposed: a separate check already guards those, and it held. Now the switches only control which tools an agent is told about, and turning a group off never grants extra automatic approval (DOR-519)
