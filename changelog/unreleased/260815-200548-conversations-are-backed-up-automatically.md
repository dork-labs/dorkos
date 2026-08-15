---
covers:
  - 'feat(db,server): automatic database snapshots, and never recreate a broken database (DOR-1224)'
  - "fix(db,server): a file at a snapshot's path is not a snapshot until it is read (DOR-1224)"
---

### Added

- Your conversations are now backed up automatically. DorkOS keeps spare copies of its database
  in a `backups` folder beside it. It saves one right before any update that changes how your
  data is stored, and one every day. It keeps ten of the first kind and a week of the second.
  Each copy is an ordinary database file you can open, move, or hand to someone else (DOR-1224)

### Changed

- If the database will not open, DorkOS now stops and tells you instead of starting up around
  it. It will never rename, replace, or try to repair the file. Usually the cause is something
  simple, like a drive that has not finished mounting, and starting fresh over the top of your
  data is the worst thing software could do at that moment (DOR-1224)
