---
covers:
  - "fix(server): room times are on the person's clock, and tasks_list says when a task runs next (DOR-3253, DOR-3125)"
---

### Fixed

- Agents in rooms now read times in your time zone. Every time in a room turn used to be UTC with nothing saying so, so an agent could call your afternoon "this evening" and had no idea what day it was for you. Now each time is in the zone set in your profile, and each turn tells the agent which zone that is and the date and time there now (DOR-3253, DOR-3125)
- An agent listing scheduled tasks now sees when each one runs next. It used to see "no next run" for every task, even ones on a schedule (DOR-3125)
