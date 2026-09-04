---
covers:
  - 'refactor(client): Badge grows the two axes its call sites kept correcting (DOR-1760)'
  - 'refactor(client): three primitives state one axis once (DOR-1760)'
  - 'refactor(client): nine hand-rolled icon buttons become Buttons (DOR-1760)'
  - 'fix(client): the settings navigation stops nesting one widget inside another (DOR-1760)'
---

### Fixed

- When the app loses its link to the server, a screen reader now says so out loud.
  Before, the warning was drawn on screen and announced to nobody (DOR-1760)
- The little coloured tags in the Marketplace that say what kind of package you're
  looking at — agent, plugin, skill pack — now pick colours made for dark mode
  instead of reusing the light-mode ones (DOR-1760)
- Small icon buttons — copy, close, fullscreen, Browse — are big enough to tap on a
  phone and show a focus outline when you reach them with the keyboard. Several were
  about half the size a thumb needs (DOR-1760)
- The settings sidebar reads correctly to a screen reader again. It described itself
  as two overlapping widgets at once, and the arrow keys now work from wherever your
  focus already is (DOR-1760)

### Changed

- The small labels dotted around the app (counts, states, categories) are drawn from
  one recipe now, so the same kind of label is the same size everywhere (DOR-1760)
