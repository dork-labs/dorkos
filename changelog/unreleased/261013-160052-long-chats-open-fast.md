---
covers:
  - 'perf(server): read a long chat once, not on every open (DOR-2889)'
---

### Fixed

- Long chats open fast. DorkOS used to read a chat's whole history from disk every time you opened it, and after every reply. A very long chat could freeze the whole app for a moment each time and use hundreds of megabytes of memory. Now DorkOS remembers what it already read and only reads what is new (DOR-2889)
