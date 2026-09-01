---
covers:
  - 'feat(server): background auth failures notify instead of dying silently (DOR-1654)'
---

### Added

- Find out when an agent's sign-in stops working, even if the work was running on its own. Before, a scheduled task, a room reply, or a message from a connected chat would just fail quietly. Now you get a note in your inbox that names which sign-in needs you: Claude, Codex, or OpenCode. You get one note per sign-in, not one for every job that failed, and opening it takes you straight to the place to sign in again (DOR-1654)
