---
covers:
  - 'feat(rooms): every message gets a menu — reply in thread from the cockpit'
---

### Added

- You can now reply to a single message in a room instead of answering into the whole conversation. Hover a message and a small toolbar appears on it with "Reply in thread" — your reply gathers under the message it answers, where everyone in the room can follow it without it burying the conversation around it. Threads have always shown up in the cockpit; until now the only way to add to one was through the API
- Right-click a message for the same actions, or press and hold on a phone for them to slide up from the bottom. It is the same short menu either way, and the same one the sidebar already uses. On a touch screen the press-and-hold is the only way in — tapping a message reads it, it doesn't offer you a menu
- Alongside replying, the menu copies a message's text — telling you it did, or that it couldn't — and offers to mention whoever wrote it, dropping the exact name that reaches them into the message box so you can be sure it will land. Mentioning is left out when nothing would come of it: on your own messages, and on anyone an `@` cannot reach
- The menu works without a mouse, and it stays out of your way. Tab moves between messages, one press each, however many actions a message has. On the message you're on, an arrow key or Enter steps into its actions, arrows move along them, and Escape comes back. Choosing "Reply in thread" puts the cursor straight in the message box, pointed at that thread
- While the box is pointed at a thread it says so, right above where you type, with a way to point it back at the room. It stays pointed there after you send, so a back-and-forth inside a thread does not mean choosing "Reply" again for every sentence
- Replying to a reply keeps you in the same thread rather than starting a new one under it. Rooms stay one level deep on purpose, so the conversation reads the same way for everyone
- A reply reaches the agents you name in it, exactly as a message to the room does. Say `@ana` in a thread and Ana picks it up, and answers in that same thread

### Fixed

- Press-and-hold menus no longer interrupt you mid-gesture. Starting a scroll or dragging to select text used to be able to open the menu under your finger; a press that travels now leaves your gesture alone
