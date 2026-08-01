---
covers:
  - 'fix(rooms): a screen reader hears what a message is about, not the diff pasted into it'
  - "fix(rooms): a room's composer says when Escape is about to clear your draft"
  - "fix(rooms): closing a thread puts you back where you were, and a room stops counting history it hasn't loaded"
  - 'fix(client): static markdown carries its own styling instead of three class names nothing generates'
  - 'refactor(rooms): drop the redundant `after:content` from the new touch targets'
---

### Fixed

- Rooms work with a screen reader now. Landing on a message used to read the whole thing out first, so a message with a pasted diff in it read the diff line by line before saying anything else. A long message now says what it is in one line; a short one still speaks for itself.
- Every message's actions can be reached by touch. The row of buttons only appeared when a mouse hovered over a message, so on a phone with VoiceOver there was no way to reply, copy or react at all. There is now a "Message actions" control on every message that works with a finger.
- The reply count under a message, the reaction pills and a thread's Back button are all big enough to tap. They look exactly the same; there is simply more of them to hit.
- Closing a thread puts the keyboard back on the message you opened it from, instead of losing your place in the room.
- A room says out loud when it has stopped receiving messages. The warning was on screen but never spoken, so the one problem nothing else reports reached a screen reader as silence.
- The `@` picker says when nobody matched what you typed.
- Pressing Escape over a half-written message shows "Press Esc again to clear", the same as everywhere else in DorkOS — so the second press is a choice rather than a surprise.
- Message times carry their full date. Hover one, and a room scrolled back a week can finally say which day it is showing.
- Long file paths and URLs inside a message wrap instead of running off the edge.
- On an iPhone, holding a message opens DorkOS's own menu instead of fighting with Apple's text-selection bubble.
- A room no longer tells a screen reader it is showing "message 12 of 30" when there is older history it has not loaded.
