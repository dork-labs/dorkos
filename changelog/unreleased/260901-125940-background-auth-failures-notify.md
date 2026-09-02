---
covers:
  - 'feat(server): background auth failures notify instead of dying silently (DOR-1654)'
---

### Added

- Find out when an agent's sign-in stops working, even if the work was running on its own. Before, a scheduled task, a room reply, or a message from a connected chat would just fail quietly. Now DorkOS notices and tells you which sign-in it was: Claude, Codex, or OpenCode. You get one note about a sign-in, not one for every job that failed because of it, and opening it takes you straight to the place to sign in again (DOR-1654)
