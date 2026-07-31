---
covers:
  - 'feat(rooms): threads get a room of their own — the side panel'
---

### Added

- Threads now open in a panel beside the room. A message with replies shows one quiet line under it — "↳ 3 replies · last 9:45 AM" — and clicking it opens the whole thread next to the conversation, with its own box to write in. The room's own scroll stays the room's, however long a thread gets. On a phone the thread takes the screen and a Back button returns you.
- A thread with replies you have not read shows that line in colour, with a count of what is new. It is worked out from where you left off in the room, so it agrees with the "New messages" line a few pixels above it.
- The waiting line follows you in. When an agent is working on something inside a thread, "Kai is working on it" appears in the panel rather than under the room, so the wait is shown where the work is happening.
- A thread has an address. The link in your browser bar now names the open thread, so a refresh keeps it open and a link you paste to somebody opens the same thread you were reading.

### Changed

- **Replies no longer gather inside the room.** Until now a thread's first three replies were drawn under the message they answered, with the rest behind a "Show 37 more". That was two ways of reading one conversation, and the longer a thread got, the more of the room it pushed off screen. There is one way now, and it is the panel. Nothing was lost — every reply is in the panel, and every reply that was already there is still there.
- "Reply in thread" opens the thread and puts the cursor in it. It used to quietly re-point the room's own box at a thread, with a small banner above as the only sign of where your next sentence was going. Now you type in the thread, so there is nothing to misread.
- An agent taking a turn inside a thread is told its answer lands in the thread rather than in the room's main flow, so it writes for the conversation it is actually in.
