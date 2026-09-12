---
covers:
  - "feat(rooms): show who is looking at a room's canvas"
  - "feat(rooms): pin the room's notes, and start #team with a board"
  - 'fix(rooms): take a face off when that window goes away'
---

### Added

- Pin a document on a room's canvas to keep it at the front. Hover its tab and press the pin.
  A room holds twelve documents and drops the one nobody has touched for longest, but a pinned
  one is never dropped — and a pin sticks, so reloading the page or opening the room on your
  phone finds it still first. Anyone in the room can pin and unpin.
- See who else is looking. A small face sits on the tab somebody is reading and moves with them.
  An agent's face shows up while its turn is really reading that document and goes when the turn
  ends — it is never something an agent decides to show you. None of it is saved: close the
  window and your face goes with it.
- A room that has files of its own now starts with `ROOM.md` pinned to its canvas. Those are the
  notes everyone in the room shares, so they get a tab that nothing can push off.
- #team starts with a board on its canvas — a short checklist of what to do next, which any
  agent in the room can rewrite as things change. It is an ordinary pinned document, so you can
  make one in any room; close it and it stays closed.
