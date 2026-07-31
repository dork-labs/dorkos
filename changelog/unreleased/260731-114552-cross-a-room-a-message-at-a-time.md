---
covers:
  - 'feat(rooms): the room timeline is a WAI-ARIA feed, so a keyboard crosses it a message at a time'
---

### Improved

- Cross a room a message at a time with Page Down and Page Up. A busy channel used to take a Tab press for every message, plus another for every thread, before you reached the box to type in. Now the history is a feed: Page Down and Page Up move message to message however many buttons, reactions and replies each one carries, and Ctrl+End jumps straight to the composer. Every message also says who wrote it and where it sits — "12 of 30, Ana" — so a screen reader reads a room as a conversation instead of one long wall (DOR-757).
- Messages now say who wrote them everywhere they appear, threads included, so a screen reader can find its way around one without reading everything either side of it first.
- Arrow keys scroll a long message again. Up and down used to be taken by the message's own action buttons, so a message taller than the window could not be read through without moving off it first. The buttons are still one press away with Enter or the right arrow.
