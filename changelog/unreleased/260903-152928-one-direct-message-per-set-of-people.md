---
covers:
  - 'fix(server,db): one direct message per set of people, enforced by the database (DOR-1616)'
---

### Fixed

- Fixed a bug where you could end up with two direct messages holding exactly the same people — two rows in the sidebar for one conversation, with half the history in each. DorkOS now keeps one direct message per set of people, and asking for a conversation you already have always brings back the one you already have. If a change to who is in a group message would create a copy of a conversation you already have, DorkOS says so instead of quietly making the copy. (DOR-1616)
