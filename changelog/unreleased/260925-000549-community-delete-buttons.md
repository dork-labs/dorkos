---
covers:
  - 'feat(community): delete and remove messages and files in the Community site (DOR-2289)'
  - "fix(community): a message can't pose as removed, and removal menus follow real roles (DOR-2289)"
---

### Added

- The Community site now has **Delete** on your own messages and files, and **Remove** for owners and admins on other people's. A confirmation says what everyone will see afterwards and what can't be taken back. The message stays in its place as "This message was deleted." or "This message was removed by a community admin.", in quieter italic text, and its thread still opens. (DOR-2289)
- A new message can no longer say only "This message was deleted." or another removal sentence, so nobody can make a message look removed when it isn't. (DOR-2289)
