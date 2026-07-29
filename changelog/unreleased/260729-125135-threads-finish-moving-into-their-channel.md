---
covers:
  - 'feat(rooms): retire the thread room, and move any that survive into its channel'
---

### Changed

- Threads finished moving into the channel they came from. If you ever started one, its messages are now replies under the message they answer, in that channel, instead of sitting in a room of their own — so there is one conversation to read and one unread count instead of two. If you were caught up before the upgrade you are still caught up. If you were behind, your unread count can come out a little high — it may include a reply you had already read inside the thread — and one visit to the channel clears it; erring that way is deliberate, because hiding something you have not read is the mistake you cannot undo. Most installs have never started a thread, and for those this changes nothing at all. (DOR-634)
