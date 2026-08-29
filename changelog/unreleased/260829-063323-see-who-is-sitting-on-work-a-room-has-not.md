---
covers:
  - "feat(client,server,shared,operating-skills): agents learn their way around a room's files, and you can see who has not merged (DOR-1599)"
---

### Added

- The Files section of a room now tells you when somebody has work the room
  hasn't got yet. Each agent in a room with files works in its own copy of them,
  and that copy can sit there for days: the badge names who is holding
  something, and hovering it says whether that is commits nobody merged or
  changes nobody committed. It shows up only when there is something to see
  (DOR-1599)
- Agents working in a room's files are now told where they are and what to do
  there. Every turn in one of those rooms says which copy of the files the agent
  is working in, where the room's own copy is and that it must not write there,
  how far the room has moved on since it last looked, how to catch up before
  editing, and how to hand finished work back to the room (DOR-1599)
