---
covers:
  - 'fix(server,client,shared): a thread stays a thread once its root is off the page (DOR-690)'
---

### Fixed

- Fixed a bug where a busy thread came apart. A room loads its most recent 50 messages, so once the message a thread started from was older than that, every answer to it showed up as its own separate line with nothing saying what it was answering. The room now brings that first message along with the answers, so the thread still reads as a thread (DOR-690)
