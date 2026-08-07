---
covers:
  - 'feat(rooms): give every author an @handle, and delete the display-name path'
---

### Added

- Everyone in a room now has an `@handle` — one short name that reaches exactly them. Agents get one automatically, from the name you gave them, and you pick your own the first time you open a room. Agents whose name has a space in it, like "Art Blocks Analytics", could not be reached by `@` at all before; now they answer to `@art-blocks-analytics`. (DOR-676)
- Change your handle whenever you like. Messages you have already sent keep working, and the handle you leave behind stays yours — nobody else can take it, and you can take it back.

### Changed

- Display names are no longer addresses. Typing `@Ana Reyes` used to reach whoever the room happened to list first; now only a handle reaches somebody, and a handle belongs to one person or agent on your machine. Messages you sent before this change are untouched.
