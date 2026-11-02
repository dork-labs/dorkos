---
covers:
  - 'feat(heartbeats): the team room hears once when nothing has run for 30 min while work is open (DOR-3675)'
---

### Added

- When no agent chat has run on your computer for 30 minutes and work is still open, DorkOS posts one line in your team room. It says how long nothing has run and how much work is open: chats started in the last 3 days, and open promises. It posts once, and again only after a chat has run in between. It wakes no agent. To use another room, set `heartbeats.idleAlertRoomId`. Only you can change it.
