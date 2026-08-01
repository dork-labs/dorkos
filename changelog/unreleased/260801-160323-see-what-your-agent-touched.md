---
covers:
  - 'fix(client): the animate-tasks pulse actually breathes'
  - "feat(client): fold a turn's tool calls into one chip per thing it touched"
  - 'feat(client): a turn shows what it touched, and the tray shows all of it'
  - 'fix(client): a touch chip says its counts out loud'
  - 'feat(client): a working turn shows the four things it is handling right now'
  - 'feat(client): chips that leave the live row land in a pile you can open'
  - 'feat(client): a file that was read and then changed morphs where it stands'
  - 'fix(client): a touch chip counts what it actually measured'
  - 'feat(client): every chip moves the way its verb moves'
  - 'feat(client): the playground shows every state a touch chip can be in'
  - 'feat(client): a simulator run that puts the chip strip through its paces'
  - 'fix(client): the chips and the tray take the shape the design record drew'
  - 'fix(client): a touch chip never claims a file it did not touch'
  - 'fix(client): the chip row stays up for the whole turn, and the morph plays'
  - 'fix(client): the tray labels its own sort, and a screen reader hears the strip'
  - 'fix(client): reduced motion leaves no colour parked on a chip'
  - 'fix(client): the playground and the design record match what shipped'
---

### Added

- **See every file and link your agent touches, live.** Each reply now carries a
  row of small chips — one per file, page, or command the agent handled — and
  each one moves the way its job moves: reading sweeps across the name, searching
  passes a beam through it, editing scribbles and counts the lines as they land,
  a new file draws its own outline, a deleted one is swallowed by the bin and
  stays behind, struck through, so a deletion is never invisible. The moment a
  job finishes, its chip goes still. Nothing you can see moving is over.
- **The row stays short, and nothing gets lost.** Only the four newest chips stay
  out front; older ones slide into a small pile beside them that counts what it
  holds. When the reply is done, the whole thing folds into one quiet line —
  `📖 21 · ✏️ 3 +34 −11 · 🌐 9` — and **show all** opens the full list, which you
  can filter by what happened and read either grouped or in the order it
  happened. A file that was read and then changed does not get a second chip: the
  one already there turns into the edited one where it stands.
- Click a chip to open that file or page beside the chat. Hovering one tells you
  the whole story of it — every time it was touched, in order.

### Fixed

- The soft pulse that says work is happening — on the thinking line, on loading
  placeholders, on connection dots — had never actually been drawn. About twenty
  places in the app asked for it and got nothing. They breathe now.
