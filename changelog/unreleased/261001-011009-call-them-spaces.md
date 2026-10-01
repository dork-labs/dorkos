---
covers:
  - 'feat(client): call them spaces, and make Start and Join the two choices (DOR-2631)'
  - 'fix(client): refuse broken invitation links and keep the old guide anchor (DOR-2631)'
  - 'test(e2e): follow the space copy into the two-desktop suite and mocks (DOR-2631)'
  - 'test(community): follow the space copy into the packaged acceptance driver (DOR-2631)'
---

### Changed

- What the app called a community is now a space, everywhere you read it: menus, dialogs, messages and the docs. The menu at the top left now offers **Add a space**. **Join a space** is there for everyone. With a DorkOS account you also get **Start a space**, and **Your spaces**, where you can move a space you run elsewhere over to DorkOS. Running a space on your own server now sits under **Advanced** (DOR-2631)
- **Join a space** is now one dialog. Paste a space's address to connect, or paste an invitation link: it opens on the space's own site so you can join, and the dialog stays open with the space's address filled in, ready to connect when you come back. A join link that is incomplete or not secure is refused with a plain message instead of being sent anywhere (DOR-2631)
