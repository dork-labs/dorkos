---
covers:
  - 'feat(server): background auth failures notify instead of dying silently (DOR-1654)'
---

### Added

- Tell you when an agent's sign-in stops working, even when the work was running on its own. A scheduled task, a room reply or a message from another agent that fails because the sign-in expired now puts a note in your inbox naming which one needs you — Claude, Codex or OpenCode — instead of failing quietly until you go looking. You get one note per sign-in, not one per thing that failed, and clicking it opens the place to sign in again (DOR-1654)
