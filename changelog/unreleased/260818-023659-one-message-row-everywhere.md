---
covers:
  - 'feat(client): P1.1 — the features/conversation slice and its model contract (DOR-1328)'
  - 'refactor(client): P1.3 — one hover-action surface, with run-with as its own slot (DOR-1328)'
  - 'refactor(client): P1.4 — the five non-message rows and the one time formatter move into the slice (DOR-1328)'
  - 'feat(client): P1.2 — Message.* is the one row (DOR-1328)'
  - 'refactor(client): P1.5 — both surfaces draw the same row, and the two old ones are gone (DOR-1328)'
  - 'feat(client): P1.7 — the Message.* matrix on the Dev Playground (DOR-1328)'
---

### Changed

- Turn on message timestamps in Settings and they now show in channels too, not only in sessions (DOR-1328)
- Rest the pointer on a message's time in a session and you get the whole date, the way a channel already did. Moving through a run of messages with the keyboard now shows each one's time as well (DOR-1328)
