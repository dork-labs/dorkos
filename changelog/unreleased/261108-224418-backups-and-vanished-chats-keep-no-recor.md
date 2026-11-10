---
covers:
  - 'fix(server): backups and vanished chats keep no recorded turn text (DOR-4001, DOR-4002, DOR-4006)'
  - 'fix(db): no backup keeps recorded turn text after a crash, a reuse or a stale copy'
---

### Fixed

- DorkOS's own database backups never keep the record of what your agents were told. Only small fingerprints and sizes stay in a backup, never the words. And when a Claude Code chat was deleted while DorkOS was closed, its record is now removed the next time DorkOS starts. (DOR-4001, DOR-4002)
