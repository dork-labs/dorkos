---
covers:
  - 'feat(db,shared): a room may carry its own automatic-reply limits (DOR-1429)'
  - 'feat(server): one ladder decides what bounds a room, and the budget owns "unlimited" (DOR-1429)'
---

### Added

- Set different reply limits for one room, or take its limits off entirely. Each room can now carry its own version of the four automatic-reply settings — how many replies in a row agents may trade, how many of those any one agent may send, how many replies the room may run in an hour, and whether it is limited at all. A room you have not touched follows Settings, and clearing a room's setting puts it straight back to that. One thing a room cannot switch off is the hourly limit across all of DorkOS: a room can opt out of its own limits, not out of your bill. Only you can change these — an agent cannot raise its own allowance (DOR-1429)
