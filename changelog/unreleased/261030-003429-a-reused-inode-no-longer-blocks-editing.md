---
covers:
  - 'fix(server): a reused inode no longer blocks editing an unrelated new file (DOR-3409)'
---

### Fixed

- On Linux and in Docker, a file you open in the canvas no longer shows editing turned off just because an earlier save of a different file was left unconfirmed. Edits to the same file, or to another name for it, still wait until that save is resolved.
