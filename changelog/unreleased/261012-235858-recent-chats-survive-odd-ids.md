---
covers:
  - 'fix: one chat with an unusual id no longer empties the recent chats list (DOR-2233)'
  - 'fix(client): keep the strict session id; warn once per unreadable recent session (DOR-2233)'
  - 'chore: one changelog fragment for DOR-2233'
---

### Fixed

- One chat the app can't read no longer empties your recent chats list. That one chat is left out, and the rest of the list shows as usual.
