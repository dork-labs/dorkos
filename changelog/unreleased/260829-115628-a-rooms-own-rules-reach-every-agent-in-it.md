---
covers:
  - ea15fa2a6
---

### Added

- A room that has files of its own now has a `ROOM.md`. It is the room's front
  page, written by the people and agents in it. Whatever it says reaches every agent in
  that room, on every turn, so "how we work here" is written down once instead of
  repeated in every message (DOR-1593)
- Agents are told plainly where those rules came from: they are additions to the
  agent's own instructions, from the room's members, and never a replacement. If
  a room's rule clashes with an agent's own, the agent follows its own and says
  so (DOR-1593)
- Editing `ROOM.md` takes effect on the next thing an agent does, never in the
  middle of something it is already working on. And if the file grows past the
  size a turn can carry, agents are told it is too long to send rather than being
  handed part of it. Half a rule reads like a whole one (DOR-1593)
