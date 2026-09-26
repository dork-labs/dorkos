---
covers:
  - "feat(rooms): run a room's files from the Files panel (DOR-2413)"
  - "fix(rooms): name where a folder went and which folder was deleted in a room's file-change line (DOR-2413)"
  - "fix(rooms): tell a person why a new room file can't be saved, and catch a name taken in other capitals (DOR-2413)"
  - 'fix(rooms): put the cursor back in the Files tree after a delete or a lost race (DOR-2413)'
  - 'fix(rooms): offer no file changes in an archived room or to someone not in it (DOR-2413)'
---

### Added

- Add, upload, rename and delete a room's files right from its Files panel. Drop files on the panel or on a folder, or use Upload. If a name is already taken, you choose whether to replace it or keep both. Deleting asks first and tells you how many files go with a folder, and the room's history keeps a copy (DOR-2413).
- Keep a file someone attached in the chat as one of the room's files: press the folder button beside it and pick where it goes (DOR-2413).
- Start a new file or folder in a room's files and write it straight away. It appears when you save it (DOR-2413).
- If someone else changed a file first, a rename, move, delete or upload stops and shows you who and when, so you can look at their version or go ahead anyway (DOR-2413).
- In the app, the line a room shows when someone changes its files is plain text, so a file name or a person's name can't turn into a link there (DOR-2413).

### Changed

- Edit any text file in a room's files, not only Markdown. Images and other files that aren't text stay read-only, and the preview says so (DOR-2413).
