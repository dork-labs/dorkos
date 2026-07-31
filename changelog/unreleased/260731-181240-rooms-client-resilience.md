---
covers:
  - 'fix(rooms): a room comes back on its own, and says what it is doing while it cannot (DOR-783)'
  - "fix(rooms): review round — settle pending on any path, and stop sweeping the room's history (DOR-783)"
---

### Fixed

- A room whose live connection dropped used to freeze for as long as you left the tab open. It now keeps trying on its own — and comes back the moment your network does, you switch back to the tab, or the rest of the app reconnects.
- Coming back to a room after a while no longer quietly loses recent messages. The room's history is kept by its live connection now, so nothing goes back and overwrites it.
- Messages you send stay on screen while they are in the air. If one doesn't get through, it says so where you typed it, with a Try again button — instead of disappearing. Try again checks whether the message actually landed first, so pressing it won't send the same thing twice.
- Making a new channel while you had a room open no longer loses recent messages from that room.
- A room you no longer have access to — deleted, or you were removed — now says so, instead of saying it is reconnecting forever.
- Your agent no longer looks like it is still working after a turn has failed.
- On a phone, the message box stays above the keyboard instead of hiding behind it.

### Changed

- The room's masthead shows a small "2 agents working" chip, so you can tell something is running without scrolling to the bottom.
- "This is taking longer than usual" is now said whenever a wait runs long, not only when a single agent is working — and the expanded list of agents says which one is slow.
- The messages a room writes about itself — an agent that was busy, a turn that failed, a limit reached — each have their own mark now, so a problem is easy to tell from an aside at a glance.
- A member's row in the room details says how long they have been working, not just that they are.
