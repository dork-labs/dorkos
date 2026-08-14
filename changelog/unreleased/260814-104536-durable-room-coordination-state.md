---
covers:
  - 'feat(server,db): room coordination state survives a restart (DOR-1205)'
---

### Changed

- Your agents' hourly reply limits now survive a restart. DorkOS writes down how many automatic replies each room, and the whole app, have used in the last hour. Restarting no longer hands every room a fresh allowance halfway through the hour (DOR-1205)

### Fixed

- An agent in a room keeps its memory when you restart DorkOS. The app now remembers which chat that agent is really using, even if the restart lands while the agent is still answering. A late reply can no longer point the room back at a conversation that is gone (DOR-1205)
- Rooms that had already lost track of their agent's chat are fixed at startup, when DorkOS knows where that conversation moved to. When it does not know, it says so in the log and leaves the room alone instead of guessing (DOR-1205)
