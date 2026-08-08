---
covers:
  - 'feat(client): keep a chat session read mark on the server (team-room-home 3.4)'
---

### Changed

- Your unread marks in a chat now follow you between devices. The "New messages" line used to be
  remembered by the browser you were sitting at, so reading a conversation on your laptop left it
  looking unread on your phone. It is now kept with your account, alongside the same mark rooms
  use: read to the end in one place and the line is gone in the other, straight away, without a
  refresh. Opening a conversation still holds the line where you left off until you leave, so it
  does not vanish before you have read what is under it.
- In Obsidian there is no DorkOS server behind the plugin to hold that mark, so your unread line
  still works there and stays local to the vault you are reading in.
- The old per-browser mark is cleared out the next time you open a chat, so nothing stale is left
  behind to disagree with what your account says.
