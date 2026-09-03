---
covers:
  - 'fix(client): a coloured border finally paints (DOR-1750)'
  - 'refactor(client): the type ramp replaces 300 hand-written pixel sizes (DOR-1750)'
  - 'fix(client): the icon-size convention is one spelling, and it works (DOR-1750)'
  - 'refactor(client): one status vocabulary for every dot, tint and row edge (DOR-1750)'
  - 'fix(client): background-task colours follow the theme (DOR-1750)'
  - 'fix(client): the terminal honours your own monospace font (DOR-1750)'
  - 'fix(client): a colourless agent keeps its own face in the exceptions strip (DOR-1750)'
  - 'refactor(client): caption indents land on the spacing grid (DOR-1750)'
---

### Fixed

- Coloured borders show up again. One line of styling had been quietly turning every coloured
  border grey, on 69 screens. Panels that were meant to look different at a glance — a
  connection that is fine, one that needs a look, one that broke — all wore the same grey
  outline. They do not any more (DOR-1750)
- Small text on a phone now grows with everything else. Timestamps, badges, keyboard hints and
  little labels were pinned to a fixed size, so they stayed tiny while the rest of the app got
  bigger. Roughly 300 of them now follow the same scale (DOR-1750)
- Icons in buttons grow on a phone too, so a small icon no longer sits in a big tap target. Two
  dialogs had icons stuck at the wrong size entirely; both are fixed (DOR-1750)
- Status colours mean one thing everywhere. Green, amber and red were spelled seven different
  ways across the app, so the same state could look green in one place and a slightly different
  green in another. There is one set now, and it is tuned for dark mode as well as light
  (DOR-1750)
- The built-in terminal uses the font you picked in Settings. It used to ignore your choice and
  draw in its own (DOR-1750)
- Running background tasks are colour-coded from the app's own palette, so their colours suit
  dark mode instead of staying the same in both themes (DOR-1750)
- An agent that never picked a colour gets its own again in Settings → Runtimes, instead of a
  flat grey (DOR-1750)
