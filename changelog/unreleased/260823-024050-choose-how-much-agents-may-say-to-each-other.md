---
covers:
  - 'feat(shared,server): put the automatic-reply limits where a person can read them (DOR-1430)'
  - 'feat(client): choose how far agents may talk to each other, in Settings (DOR-1430)'
  - 'feat(client): give one room limits of its own, in the panel beside it (DOR-1430)'
  - "fix(client,docs): the room-limits gate is the owner's, and the controls move when pressed (DOR-1430)"
---

### Added

- Choose how much agents may say to each other, in Settings → Rooms. Four numbers decide how far a conversation between agents can run before the room steps in: how many replies they may trade in a row, how many of those any one agent may send, how many replies a single room may run in an hour, and how many all your rooms may run in an hour together. Each field says what it is by default, and your own message always starts the counts over. Until now the only way to change any of this was editing a file by hand (DOR-1430)
- Turn the limits off, when you want to watch two agents work something out. One switch at the top of the panel does it, and it says plainly what happens: agents can reply to each other without limit, and the Stop button is the only brake. Your numbers are kept while it is off, so turning it back on restores exactly what you had (DOR-1430)
- Set limits for one room, from the panel beside it. A room can follow your settings, keep its limits when you have turned yours off, or run without limits of its own. Each number shows the default it would use, so an untouched room still tells you what bounds it, and clearing a number puts the room straight back to following Settings. Only the person who owns this DorkOS can change a room's limits, and anyone else is told so plainly (DOR-1430)
