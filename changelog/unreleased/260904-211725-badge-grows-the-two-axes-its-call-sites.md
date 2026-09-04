---
covers:
  - 'refactor(client): Badge grows the two axes its call sites kept correcting (DOR-1760)'
  - 'refactor(client): three primitives state one axis once (DOR-1760)'
---

### Fixed

- When the app loses its link to the server, a screen reader now says so out loud.
  Before, the warning was drawn on screen and announced to nobody (DOR-1760)
- The little coloured tags in the Marketplace that say what kind of package you're
  looking at — agent, plugin, skill pack — now pick colours made for dark mode
  instead of reusing the light-mode ones (DOR-1760)

### Changed

- The small labels dotted around the app (counts, states, categories) are drawn from
  one recipe now, so the same kind of label is the same size everywhere (DOR-1760)
