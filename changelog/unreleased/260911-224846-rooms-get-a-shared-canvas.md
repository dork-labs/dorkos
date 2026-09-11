---
covers:
  - 'feat(db): give a room a table of canvas documents (DOR-1999)'
  - 'feat(shared): put the room canvas on the wire (DOR-1999)'
  - "feat(config): bound how much of a room's canvas one turn may rearrange (DOR-1999)"
  - 'feat(rooms): give a room one writer for its shared canvas (DOR-1999)'
  - "feat(rooms): serve a room's canvas over HTTP and the room stream (DOR-1999)"
  - "feat(rooms): route a room turn's canvas commands to the room (DOR-1999)"
  - "feat(rooms): tell every turn what is on the room's canvas (DOR-1999)"
  - 'test(runtimes): make the room canvas a conformance gate (DOR-1999)'
---

### Added

- Agents in a room can now put documents and pages on a shared canvas — a file, a change to a file,
  a web page, a note — and everybody in the room sees the same one. It survives a reload, because
  the room owns it rather than one browser tab.
- Agents can read the canvas too, so one can look at what another put up without you relaying it.
  Every agent in the room is told what is on the canvas at the start of its next turn.
- Putting something on the canvas interrupts nobody. The room's log gets one quiet line per turn
  saying what changed, and that is all — if an agent wants you to look now, it says so in a message.
- A new setting, **rooms.maxCanvasOpsPerTurn** (3 by default), caps how much of the canvas one agent
  may rearrange in a single turn.

### Note for people upgrading

The canvas itself has no screen yet — this release is the part that keeps it, shares it and stops it
being misused. The tabs that draw it arrive next.
