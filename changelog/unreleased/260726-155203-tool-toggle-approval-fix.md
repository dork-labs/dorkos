---
covers:
  - "fix(security): tool-group toggles no longer widen an agent's auto-approval (DOR-519)"
---

### Fixed

- Turning off a group of tools for an agent had the opposite effect: instead of holding those tools back, it let the agent run about 30 other DorkOS tools, including deleting scheduled tasks and removing agents, without asking you first. Now the switches only control which tools an agent is told about. Turning a group off never grants extra automatic approval, so you still get asked before anything risky happens (DOR-519)
