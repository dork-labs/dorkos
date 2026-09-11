---
covers:
  - 'feat(canvas): split the browser into its own right-panel tab'
  - 'test(e2e): drive the workbench preview through the Browser tab'
  - 'docs(workbench): describe the Canvas and Browser tabs'
---

### Added

- A **Browser** tab in the workbench, next to Canvas. Web pages open there — a local file you are
  building, a dev server you are running, or a site your agent wants you to see — while files,
  documents and diffs stay in Canvas.
- Each of the two tabs keeps its own set of open documents and remembers the one you were reading.
  Switch to Browser and back, and the file you had open is still the one on screen.

### Changed

- When an agent opens a page for you, DorkOS brings up the Browser tab instead of the Canvas tab, so
  a page it sends never takes over the file you were reading.

### Note for people upgrading

- Showing a page needs a server to serve your files and reach your dev server, so the Browser tab is
  part of the web app and does not appear in the Obsidian plugin. Everything you had open is still
  open — pages just moved one tab along.
