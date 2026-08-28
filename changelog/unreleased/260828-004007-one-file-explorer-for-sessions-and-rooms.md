---
covers:
  - 'feat(client): one file explorer for sessions and rooms, with provenance and pinning (DOR-1595)'
---

### Added

- Rooms that have files of their own now show them, in the room panel. The list is read-only for now, and every entry says who last changed it and when. Rooms without files of their own look exactly as they did.
- Files can be opened straight from a room's list: text and markdown show in place, and anything that can't be shown — a picture, something too big, a link — says so plainly.
- A room's file list hides the machinery by default — dotfiles, `node_modules`, and the folders your tools keep for themselves — with an eye button to show it again. The session Files panel already hid its own; now both do, and one button means the same thing in both.

### Changed

- `ROOM.md` and `README.md` now sit at the top of the file list, where you'd look for them. This applies to the session Files panel too.
- The Files panel on a session and the new file list in a room are the same thing underneath now, so anything either of them learns, both of them get.
