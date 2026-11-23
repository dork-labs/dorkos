---
covers:
  - 'feat(rooms): agents hand long work to one lead chat and keep rooms to three updates (DOR-4469)'
---

### Changed

- Agents in a room stay quieter. Long work now goes to one lead chat, which messages the agent who has to act directly instead of posting every step. The room hears when work starts, when it's waiting on a person, and when it ships. Ask a question there and you still get an answer (DOR-4469).
- To make one room stricter, paste a short set of rules into its `ROOM.md`. The rooms guide has an example you can copy (DOR-4082).
