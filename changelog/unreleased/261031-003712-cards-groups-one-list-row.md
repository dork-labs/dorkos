---
covers:
  - 'feat(client): borderless cards, settings groups without rules, and one list row'
  - 'fix(client): on a phone a list row gives its title the width, and state copy wraps'
  - 'fix(client): a list row's ghost button under the copy starts where the text does'
---

### Changed

- Cards no longer draw a border. Their soft shadow sets them off the page, and in dark mode they sit a step lighter.
- Settings groups are a soft tint instead of an outlined card, with no lines between rows, and in dark mode they no longer look like a hole in the dialog.
- The danger zone in Settings loses its red outline. The heading and the red button say it.
- Hovered and selected rows use one set of tints everywhere, and keyboard focus on a row is an outline inside the row, so it is no longer cut off at the edge of a list.
- Interactive cards lift with their shadow only, without the one-pixel jump.

### Fixed

- Faint and red text on a selected row inside a dark dialog is easier to read.
- A card's title no longer clips its descenders on a phone.
