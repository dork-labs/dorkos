---
covers:
  - 'fix(canvas): keep a file opened before the session stream attaches (DOR-2016)'
  - 'test(canvas): cover a first-turn rename with open documents (DOR-2015)'
---

### Fixed

- A file you open the instant a new conversation starts now stays open. If opening something from
  the file tree was the very first thing you did in a brand-new conversation, it could vanish again a
  moment later, with a message saying "Session not found" about the conversation you were looking at.
  DorkOS was asking the server to remember the file before the conversation had finished connecting,
  and the server had nothing to attach it to yet. Now DorkOS waits a beat and sends it as soon as the
  connection is ready, so the file simply stays where you put it — and is still there after a reload.
  If a conversation really is gone, you are still told.
