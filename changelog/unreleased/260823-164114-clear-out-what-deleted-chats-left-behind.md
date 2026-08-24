---
covers:
  - 'fix(server): clear out what deleted chats left behind (DOR-1436)'
  - 'fix(server): never mistake a linked project folder for a deleted chat (DOR-1436)'
---

### Fixed

- Messages you queued and context you added for a chat that was deleted while DorkOS was closed are now cleared out the next time it starts, instead of sitting in your database forever. DorkOS only clears a chat it can confirm is gone — anything it cannot check is left exactly where it is (DOR-1436)
