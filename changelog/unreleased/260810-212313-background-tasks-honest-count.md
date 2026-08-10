---
covers:
  - 'fix(server,client): a background task DorkOS lost sight of is not a task that stopped (DOR-1108)'
  - 'fix(server): a background task that goes quiet stops counting as running (DOR-1104)'
  - 'fix(server,client): one retirement per expired child, and no tick for one nobody watched (DOR-1104, DOR-1108)'
---

### Fixed

- A background task that never reported back could leave your session saying "still
  working in the background" forever. Nothing in DorkOS could clear it, so the count
  sat there for the life of the session. Now a task that has gone quiet for fifteen
  minutes, on a session that has finished talking, stops counting. Tasks that keep
  checking in keep their place however long they run (DOR-1104)
- DorkOS no longer says a background task stopped when all it knows is that it can no
  longer see it. When your agent finishes, anything it started inside itself is gone
  with it — but something it launched to keep running on its own, like a dev server,
  carries on, and DorkOS cannot tell the two apart. It now says it lost track of the
  task and that it may still be running, instead of reporting a stop that may never
  have happened. These tasks are not marked as finished or failed, because DorkOS did
  not see either one happen (DOR-1108)
