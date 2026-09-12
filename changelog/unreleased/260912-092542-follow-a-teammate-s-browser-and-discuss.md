---
covers:
  - "feat(rooms): follow a teammate's browser, and discuss a document (DOR-2010)"
  - "feat(rooms): a Follow button and a Discuss button on a room's canvas (DOR-2010)"
  - "test(rooms): drive following and a document's discussion in a real browser (DOR-2010)"
  - 'fix(canvas): name the reset suite among the readers of the retired key'
  - "fix(rooms): keep a follow alive while the leader is still, and sign the room's own lines (DOR-2010)"
  - 'fix(rooms): pin the forget-on-leave wiring, and resolve one author per row (DOR-2010)'
---

### Added

- Follow somebody's browser in a room. Pick a person on the Browser tab and your panel goes where theirs goes — the same page, the same place on it — until you turn it off. It's people only, it's off until you ask for it, nothing about it is recorded, and it stops on its own when you look away or the person you're following goes quiet. A room where nobody is following anybody sends nothing extra at all. (DOR-2010)
- Talk about one document on a room's canvas. Press **Discuss** on any tab and a thread opens on it, with a short line in the room saying you started one. Press it again next week and you land in the same conversation, and so does everybody else — there is one discussion per document. Asking an agent something in it tells the agent about that document and no other. (DOR-2010)

### Fixed

- Lines the room writes about you — a merge, a change to the canvas, the one that opens a document's discussion — now show your name and your face. They used to be signed "Unknown", which read as if nobody wrote them. (DOR-2014)
