---
covers:
  - 'fix(server): a room no longer says an agent was busy with its own turn (DOR-1230)'
---

### Fixed

- Message an agent again while it is still working in the same channel, and the room no longer posts "it was busy and didn't pick this up — send it again" just before the answer lands. That note was never true there: the message was already held and about to be answered. It now appears only when somebody else really is working with that agent somewhere else (DOR-1230)
