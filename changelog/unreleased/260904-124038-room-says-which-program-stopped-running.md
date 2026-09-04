---
covers:
  - 'fix(server,client,shared): a room says which program stopped running, and how to get back (DOR-1720)'
---

### Fixed

- A conversation whose agent runs on Claude, Codex or OpenCode now says so by name when
  that program is no longer running on your machine — and tells you the two ways back:
  turn it on again to pick up where you left off, or take the agent out of the
  conversation and add it back to start fresh. Before, every message got the same
  "ran into a problem" apology and pointed you at a session that was always empty, so
  the only way to fix it was to already know how (DOR-1720)
- That line is written once while the situation lasts, instead of once for every message
  you send (DOR-1720)
- A session you open from the sessions list says the same thing in the same words when
  the program it runs on isn't running (DOR-1720)
