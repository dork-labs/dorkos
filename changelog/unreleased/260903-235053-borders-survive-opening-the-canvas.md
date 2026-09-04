---
covers:
  - 'fix(client): every border keeps its colour once the canvas editor loads (DOR-1024)'
---

### Fixed

- Opening a document in the canvas editor no longer repaints every border in the app.
  The editor brings its own stylesheet, and that stylesheet was resetting the app's
  border colour to the text colour — so cards, buttons, inputs and filter pills all
  picked up a hard near-black outline (a washed-out light one in dark mode) and kept
  it until the next reload. Measured across thirteen screens in both themes (DOR-1024)
- Coloured borders now work inside the Obsidian panel too, the same way they do in the
  app (DOR-1024)
