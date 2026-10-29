---
covers:
  - 'Revert "fix(server): outside words no longer hold a whole room of agents to asking (DOR-3390)"'
---

### Security

- Undid a change from 0.126.3 that let agents in a shared room work at their usual level after one of them read an outside message. It allowed some actions without asking you first. Agents in that room ask you before acting again, as in 0.126.2. Please update.
