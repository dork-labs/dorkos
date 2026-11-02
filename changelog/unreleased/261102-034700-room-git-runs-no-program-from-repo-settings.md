---
covers:
  - "fix(rooms): the server's git in a room or a local workspace source runs no program the repo's settings name (DOR-3667)"
  - 'fix(rooms): room git never starts automatic gc, and the allowlist names gc keys one by one (DOR-3667)'
---

### Fixed

- DorkOS's own git work in a room's shared folder can no longer be made to run a program by settings an agent wrote into that folder's git setup. A room whose git settings hold anything unusual now stops until you remove it, and DorkOS names exactly what to remove.
- A workspace copied from a folder on your computer has its git settings checked first, however the folder's address is written.
