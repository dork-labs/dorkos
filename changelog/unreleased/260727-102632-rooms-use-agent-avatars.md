---
covers:
  - 'refactor(rooms): rooms use the avatars agents already have (DOR-521)'
---

### Changed

- Your agents now look the same everywhere. A room used to draw a coloured letter for each
  member, so the same agent showed up as its emoji in one list and an unrelated "K" in the room
  right beside it. Rooms now use the emoji and colour the agent already has, and a direct
  message wears the face of whoever it is with (DOR-521)
- Opening the sidebar no longer asks the server about every direct message one at a time — the
  room list already says who is in each one (DOR-521)
