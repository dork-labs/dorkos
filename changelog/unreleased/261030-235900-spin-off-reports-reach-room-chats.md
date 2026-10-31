---
covers:
  - 'fix(server): a spin-off started from a room reports back to the agent there (DOR-3488)'
  - "fix(server): a spin-off's title cannot fake a marker in its room seat's report (DOR-3488)"
---

### Fixed

- When an agent in a room starts a separate chat for a long job, that chat's updates now reach the agent when the work finishes, fails or needs you. The agent sees the update on its own and decides whether the room needs to hear it. Before, those updates were dropped, and the agent never knew the work was done.
