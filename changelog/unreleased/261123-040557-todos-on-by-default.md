---
covers:
  - 'feat(todos): to-dos are on by default (DOR-5071)'
---

### Added

- To-dos are on for everyone. One list for what you and your agents need to do: give a to-do to a person or an agent, and mark it kept when it's done. Agents can add and keep to-dos too; the To-dos permission decides whether they may. To turn them off, start DorkOS with `DORKOS_TODOS_ENABLED=false` (DOR-5071).

### Changed

- If you've set up a DorkOS account, a message to an agent in your Direct chat gets your full power only when it comes from you while signed in. A script or command-line tool at this computer can still send one, but the agent's reply then runs with the limited power a stranger's message gets. To give a message your full power, send it from the app while signed in (DOR-5071).
