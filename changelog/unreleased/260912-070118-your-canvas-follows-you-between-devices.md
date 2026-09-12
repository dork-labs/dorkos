---
covers:
  - "refactor(canvas): one writer for a room's table and a session's (DOR-2006)"
  - 'feat(canvas): the session canvas gets routes, a reader, and a way to be reclaimed (DOR-2006)'
  - 'feat(canvas): your canvas follows you between devices (DOR-2006)'
  - 'fix(canvas): let a canvas frame reach the other window, and say so in the docs (DOR-2006)'
  - 'test(canvas): cover the canvas the Obsidian embed can read (DOR-2006)'
  - 'fix(canvas): resolve the viewer where the row is written, and let the embed read (DOR-2006)'
---

### Changed

- Your canvas now lives on your DorkOS machine instead of in one browser. Open a file on your
  laptop and it's already open when you pick the session up on your phone; close it there and it
  closes on the laptop. Clearing your browser data no longer costs you your tabs, and two windows
  on the same session show the same set instead of drifting apart. Anything you had open is
  carried over the first time you open that session (DOR-2006).
- Your agent can see what's on your canvas, and read it. Ask "what have we got open?" and it gets
  the real list — every tab, what it is, what it's called, which one is at the front, and how many
  windows are watching — instead of guessing from whatever your window last mentioned. It can read
  one of those documents back too, like the chart it drew for you last turn, and a document backed
  by a file is read off disk so you get what the file holds now (DOR-2006).
