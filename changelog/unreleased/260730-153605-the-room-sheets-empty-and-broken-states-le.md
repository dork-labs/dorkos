---
covers:
  - "feat(rooms): the room sheet's empty and broken states lead somewhere"
---

### Changed

- Opening the sheet for a room with no agents in it now opens the agent picker straight away, with the cursor in it — a room with nobody in it does nothing, so putting somebody in it is the only thing worth offering.
- "You have not added any agents yet" now comes with a **Create agent** button instead of being a dead end.
- When the list of who is in a room can't be read, there is now a **Try again** button. It used to ask you to close the sheet and open it again, which is the same thing, done by hand.
