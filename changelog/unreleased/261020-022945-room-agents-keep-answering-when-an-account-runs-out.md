---
covers:
  - 'feat(rooms): room agents keep answering when an account runs out (re-seat)'
---

### Added

- An agent in a channel or DM whose Claude account runs out now moves to the account with the most usage left and answers the same message, on its own. The room gets one short line saying so. If no account has usage left, the room says when the soonest one is back.
- An agent whose account is almost out (95% of its 5-hour or weekly limit) moves before it starts, so its answer isn't cut off.
- An agent whose earlier chat in a room has expired starts a fresh one there and says so, instead of quietly forgetting.
- A person can move an agent in a room to another account by hand, through the DorkOS MCP server or the app's API. The button in the app comes next.

### Note for people upgrading

- Rooms have one new kind of notice line, for an agent that moved to another account. An older app reading a newer server will not understand it, so update both together.
