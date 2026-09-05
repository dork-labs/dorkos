---
covers:
  - 'fix(server): relay conversations bind their runtime at first turn (DOR-1774)'
---

### Fixed

- Editing an agent's setup in the middle of a conversation no longer switches which AI tool answers — the conversation stays where it started. When one agent messages another, DorkOS used to re-read the target agent's setup on every message, so changing it mid-chat handed the rest of the conversation to a tool that had never seen any of it and answered from nothing. The change now takes effect on the next conversation instead (DOR-1774)
