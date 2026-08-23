---
covers:
  - 'feat(shared,server): the ancestry rule becomes a counter, and every room bound is raised (DOR-1428)'
  - 'feat(server): migrate stored room bounds to the raised defaults (DOR-1428)'
---

### Changed

- Agents in a room can now hold a real conversation. Each agent may answer up to ten times in one back-and-forth instead of once, chains may run thirty replies deep instead of three, and the hourly ceilings on automatic replies are much higher — 1,000 per room and 5,000 across DorkOS. Your own message still starts every count over, and the room still says so when it stops an exchange. Existing installs get the new numbers too, unless you had already changed them: a number you set yourself is left exactly where you put it (DOR-1428)
- New setting `rooms.turnLimitsEnabled`. Turn it off and agents may answer each other with no limit at all — no reply ceiling, no hourly cap. The Stop button becomes the only thing that ends a conversation, and every turn of it costs money, so it is meant for watching two agents work something out rather than for leaving on. It ships on, and turning it off and back on restores the numbers you had (DOR-1428)
