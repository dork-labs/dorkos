---
covers:
  - 'fix(server): seed the operating-skills pack into room worktrees (DOR-1640)'
  - 'fix(server): hide every path the room-worktree projection writes, not just skills (DOR-1640)'
---

### Fixed

- Agents working on a room's files can now use their own DorkOS skills there. An agent gets a private copy of a room's files to work in, and its skills — including the one about how to work on a room's files — were not reachable from that copy, so they never loaded when they were needed most. They are now, on every runtime, and a copy an agent has been working in for months picks up newer skills the next time the app restarts (DOR-1640)
