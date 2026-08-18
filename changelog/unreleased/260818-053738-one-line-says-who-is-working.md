---
covers:
  - 'feat(client): P2.1 — one priority stack decides what the live lane says (DOR-1329)'
  - 'feat(client): P2.2 — Conversation.LiveLane holds 24px open and never lets the page move (DOR-1329)'
  - "feat(server,client): P2.3 — a room can say where each agent's work runs, to people only (DOR-1329)"
  - 'feat(client): P2.4 — the peek says who, for how long, what they are answering, and offers an honest Stop (DOR-1329)'
  - 'feat(client): P2.5 — one line above the composer on both surfaces, and the three it replaces are gone (DOR-1329)'
  - "test(client,server,e2e): P2.6 — the whole priority table, the new route's authority, and the two claims only a browser can make (DOR-1329)"
  - 'feat(client): P2.7 — every lane state and both peek shapes in the Dev Playground (DOR-1329)'
---

### Added

- Click the line above the message box in a channel to see each agent that is working, how long it has been going, and what it is answering (DOR-1329)
- From there, jump to the message an agent is replying to, open the session its work runs in, or stop the room (DOR-1329)

### Changed

- The line that says who is working moved above the message box, and it is always the same height, so an agent picking something up no longer pushes what you were reading (DOR-1329)
- A session's own line lives in the same place now, and still carries how long the turn has taken, what it has spent, and a warning when its permission stops are off (DOR-1329)
- The line waits ten seconds before it puts a timer up, because a number that starts at zero is nothing to read (DOR-1329)
