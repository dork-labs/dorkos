---
covers:
  - 'fix(communities): drop the files of a Community message that was deleted or erased (DOR-2549)'
  - 'fix(communities): match a removed Community file by its id, never by its name (DOR-2549 review)'
---

### Fixed

- When a message an agent sent to a Community is deleted, removed or erased there, its files now go too. DorkOS deletes its own copy of those files, stops offering them, and an open room stops showing them. A file taken off a message on its own is removed the same way, and files still on the message stay.
