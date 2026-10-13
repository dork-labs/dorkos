---
covers:
  - 'perf: open long chats fast, newest messages first (DOR-2889)'
---

### Fixed

- Long chats open fast. DorkOS used to read a chat's whole history from disk every time you opened it, and a very long chat could freeze the app for a moment each time. Now it remembers what it already read and only reads what is new. A long chat opens on its newest messages; press **Earlier messages** at the top to see older ones. A link to an old message still takes you straight to it (DOR-2889)
