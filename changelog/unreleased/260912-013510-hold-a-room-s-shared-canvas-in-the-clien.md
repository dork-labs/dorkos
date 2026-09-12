---
covers:
  - "feat(rooms): hold a room's shared canvas in the client, live off its stream"
  - 'feat(rooms): give a room a Canvas and a Browser tab everybody shares'
  - "test(rooms): drive a room's shared canvas through two real browsers"
---

### Added

- Rooms now have a Canvas and a Browser tab, and what is on them belongs to the room rather than
  to your browser. When an agent puts a document there, everyone in the room sees it — at the same
  moment, without reloading — and it is still there tomorrow. Each tab says who put it there
  (DOR-2000)
- You can put things on the table too: type an address in the Browser tab, pick a starting point in
  an empty one, or press "Put on the canvas" on a file in the Room tab's Files section. Pin the ones
  that matter so they stay at the front, and close the ones that do not — for everybody
- Markdown the room owns can be edited right there, and your save reaches everyone. While you are
  typing, an agent's change to that same document is held rather than dropped on top of you; every
  other document stays live
- A document that arrives while you are looking somewhere else lights a small dot on the tab it
  landed on. Nothing ever moves the tab you are on, and nothing interrupts you mid-edit
