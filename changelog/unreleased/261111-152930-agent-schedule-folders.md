---
covers:
  - 'fix(tasks): keep agent-created schedules in a safe agent folder (DOR-4067)'
  - "fix(tasks): an agent's schedule follows the DOR-4136 level rule for its folder (DOR-4067)"
  - 'fix(tasks): tasks_create defaults target in its handler, and the skill pack moves to 55 (DOR-4067)'
  - 'fix(tasks): at Full only the home folder is allowed; the data folder and protected folders stay refused (DOR-4067)'
---

### Security

- A schedule an agent makes now runs in that agent's own folder, even when the agent asks for a "global" one or names no place. DorkOS refuses the schedule up front if that folder is the DorkOS data folder, or, below Full autonomy, your home folder, so nothing is saved there. Schedules you make yourself work as before.
