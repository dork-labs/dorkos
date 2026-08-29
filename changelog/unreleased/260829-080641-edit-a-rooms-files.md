---
covers:
  - "feat(server,shared,client): a person can save a room's file, and a stale save is refused (DOR-1600)"
  - 'fix(server,shared): nine findings from the DOR-1600 adversarial review'
  - "feat(client,shared): a person can open a room's file, change it, and be told when somebody else got there first (DOR-1601)"
---

### Added

- A room that has files of its own now shows them in the room panel, and you can
  open one to read it. Each file says who last changed it and when, and the
  room's ROOM.md sits at the top where you can find it (DOR-1600, DOR-1601)
- You can now edit a room's markdown files in DorkOS and save them. Each save is
  one entry in the room's history, with your name on it, so the room can always
  say who wrote what. Other kinds of file are still read-only for now
  (DOR-1601)
- If somebody else changes the same file while you have it open, DorkOS will not
  quietly write over their work or throw yours away. It tells you who got there
  first and what they said they were doing, and you choose: open their version,
  or save yours over it (DOR-1600, DOR-1601)
- If somebody changes a room's files outside DorkOS — in a terminal, say —
  saving in that room stops until it is sorted out, and the room now says so
  instead of just refusing. It lists what changed and gives you two ways out:
  keep it all as one saved change, or throw away exactly the files you tick
  (DOR-1600, DOR-1601)
- Saving a file that is too large now says so plainly, instead of answering with
  a server error that told you nothing you could act on (DOR-1600)
