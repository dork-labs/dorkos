---
covers:
  - 'feat(sidebar): Today and agent clicks follow what you touched (DOR-2789)'
  - 'fix(sidebar): keep the digest on landing and record only visible chats (DOR-2789)'
  - 'refactor(session): name the chat route through SESSION_ROUTE in the open recorder (DOR-2789)'
---

### Changed

- Today keeps the chats you actually used. A chat you opened or typed in since 4am stays in Today, even when a dozen agent chats have been busier since. A chat a room, a schedule or another agent started becomes yours the moment you open it or type in it (DOR-2789)
- Clicking an agent opens the chat you were last in with it, not whichever chat the agent was busiest in. A chat another chat started is never picked unless you have used it (DOR-2789)
- This works the same on every device. The app remembers which chats you opened or typed in, so your desktop, your phone and a second browser all agree. Opening a chat from a link, a notification or a reload counts too (DOR-2789)
