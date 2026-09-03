---
covers:
  - 'fix(server,shared): two first boots settle on one secret key (DOR-712)'
  - 'fix(server,shared): publish first-boot secrets whole, or not at all (DOR-712)'
  - 'fix(server): parse a quarantined keypair before publishing over it (DOR-712)'
---

### Fixed

- Fixed a rare first-start problem where two DorkOS processes opening the same brand-new data folder at once — a server plus a CLI command, or a dev server plus the app — each made their own copy of a secret key and one copy was thrown away. Whatever the discarded key had locked up (saved connection credentials, signed-in sessions, browsers signed up for notifications) could never be opened again. Now the first process to finish writing the key wins and everything else uses that one (DOR-712)

### Note for people upgrading

- If a secret file in your data folder is empty — which only happens when a much older version was interrupted the first time it started — DorkOS now stops with a message naming the file instead of quietly replacing it. Replacing it is what loses the data it was protecting. Move the file aside or delete it to have a new one made
