---
covers:
  - 'refactor(client): Badge grows the two axes its call sites kept correcting (DOR-1760)'
  - 'refactor(client): three primitives state one axis once (DOR-1760)'
  - 'refactor(client): nine hand-rolled icon buttons become Buttons (DOR-1760)'
  - 'fix(client): the settings navigation stops nesting one widget inside another (DOR-1760)'
  - 'test(client): match the collapsed limits label loosely (DOR-1760)'
  - 'chore(changelog): fold batch 14 fragments into one entry (DOR-1760)'
  - 'fix(client): the path field and its Browse button share one disabled state (DOR-1760)'
  - 'fix(client): the active chip keeps its accent border in dark mode, and only toggle-bearing dialogs pay for its clearance (DOR-1760)'
---

### Fixed

- The little coloured tags in the Marketplace that say what kind of package you're
  looking at — agent, plugin, skill pack — now pick colours made for dark mode
  instead of reusing the light-mode ones (DOR-1760)
- Small icon buttons — copy, close, fullscreen, Browse — are big enough to tap on a
  phone and show a focus outline when you reach them with the keyboard. Several were
  about half the size a thumb needs (DOR-1760)
- The settings sidebar reads correctly to a screen reader again. It described itself
  as two overlapping widgets at once, and the arrow keys now work from wherever your
  focus already is (DOR-1760)
- A greyed-out folder field greys out its Browse button too, instead of offering to
  change something you can't (DOR-1760)
- A long dialog heading no longer runs underneath the expand button in the corner
  (DOR-1760)

### Changed

- The small labels dotted around the app (counts, states, categories) are drawn from
  one recipe now, so the same kind of label is the same size everywhere (DOR-1760)
- The connection-lost banner now announces itself to screen readers, so whenever it
  does reach the screen it says so out loud instead of silently changing colour
  (DOR-1760)
