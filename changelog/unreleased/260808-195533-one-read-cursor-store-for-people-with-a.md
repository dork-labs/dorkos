---
covers:
  - 'feat(server): one read-cursor store for people, with a broadcast route (team-room-home 3.1 + 3.2)'
---

### Added

- DorkOS now keeps one record of where you have read up to, for every kind of conversation you
  have — rooms, chats with your agents, and your inbox. It is yours alone, and it tells your
  other open screens the moment it moves, so nothing waits on a refresh. Your agents keep their
  own separate place in a room, and nothing they do there moves yours
