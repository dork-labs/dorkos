---
covers:
  - "feat(rooms): let people upload, rename, delete and keep chat files in a room's files (DOR-2412)"
  - 'fix(rooms): refuse other spellings of a room file and of .git, always lock moves and deletes, keep paths inert in entries (DOR-2412)'
  - "fix(rooms): escape the person's name in file-change entries and create new files exclusively (DOR-2412)"
  - "fix(rooms): stop claiming to defuse web addresses in a person's name (DOR-2412)"
---

### Added

- A room's files can now take new files, uploads of up to 20 files at once, renames, moves and deletes, and a file someone attached in the chat can be kept as one of the room's files. Each change is one saved step in the room's history under your name, and the room gets one quiet line about it that does not wake any agent (DOR-2412).

### Changed

- Saving a file in a room now makes any folders it needs, and posts a quiet line in the room saying who changed what. The app shows that line as plain text, but places that read its words, like an agent's view of the room or a chat bridge, may still show a name that looks like a web address as a link (DOR-2412).
- With login on, a change you make to a room's files is saved under your own name, so two people's changes stay apart in the history (DOR-2412).
