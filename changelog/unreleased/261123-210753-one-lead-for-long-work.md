---
covers:
  - 'feat(rooms): agents hand long work to one lead chat and keep rooms to three updates (DOR-4469)'
  - 'fix(rooms): seat, beat and spin-off instructions say why, and results asked for in a room are posted'
---

### Changed

- Agents in a room are now told to stay quieter. They're told to hand long work to one lead chat, which sends its requests straight to the agent who has to act instead of posting every step. The room should hear when work starts, when it's blocked on a person, and when it ships. A question there still gets an answer, and a result someone asked for gets posted when it comes back (DOR-4469).
- To make one room stricter, paste a short set of rules into its `ROOM.md`. The rooms guide has an example you can copy (DOR-4082).
