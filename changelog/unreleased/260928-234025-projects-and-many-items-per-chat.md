---
covers:
  - 'feat(server): know every project by one short name, and every item a chat works on (DOR-2522)'
  - "fix(server): keep the live session stream off git, and trackerItem to this chat's own run (DOR-2522)"
  - 'fix(server): keep outside repositories and extension-named folders out of the project list (DOR-2522)'
  - 'fix(server): hold the project cap under bursts, and answer null on a storage clash (DOR-2522)'
---

### Added

- DorkOS now keeps a list of the projects on this computer, each with a short name that never changes, so a link to a project keeps working. A worktree or a subfolder counts as the project it belongs to (DOR-2522)

### Fixed

- A chat that works on several flow items now shows all of them, not just the newest one. The account popover says "Working on 3 items" when there is more than one, and work a chat started in chats of their own is listed too (DOR-2522)
- The flow item a chat works on no longer disappears from the chat's account popover when the session list refreshes (DOR-2522)
