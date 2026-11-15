---
covers:
  - 'fix(tasks): keep agent-created schedules in a safe agent folder (DOR-4067)'
---

### Security

- A schedule an agent makes now runs in that agent's own folder, even when the agent asks for a "global" one or names no place. Below Full autonomy, DorkOS refuses the schedule up front if that folder is your home folder or the DorkOS data folder, so nothing is saved there. Schedules you make yourself work as before.
