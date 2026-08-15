---
covers:
  - 'feat(server,cli,shared): save any room as a file you can read and keep (DOR-1225)'
---

### Added

- Save any channel or direct message as a file with `dorkos room export #backend`. You get one message per line, with names, times, threads, reactions and the files people shared, so you can search a conversation with the tools you already use or keep a copy of your own. Exporting changes nothing — the room carries on exactly as it was (DOR-1225)
