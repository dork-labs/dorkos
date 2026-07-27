---
covers:
  - 'feat(client): open agents in tabs instead of new windows (DOR-540)'
  - 'fix(client): only a history traversal may move focus between tabs (DOR-540)'
  - 'fix(client): answer the shell truthfully when Cmd+W closes a tab (DOR-540)'
  - 'fix(client): correct three stale rationales and hold the close answer (DOR-540)'
  - 'fix(client): in a browser, use browser tabs (DOR-568)'
  - 'fix(client): the seam decides the surface, not the app entry (DOR-568)'
---

### Added

- Open your agents in tabs in the desktop app, the way you already work in a browser or an editor.
  The tab strip runs across the top of the window, and the `+` button opens another one (DOR-540)
- Those tabs tell you what your agents are doing while you are looking somewhere else. A tab lights
  up when its agent starts working, needs an answer from you, or hits a problem. You can leave five
  agents running and glance at the strip to see which one wants you
- Keyboard shortcuts for the desktop app's tabs: `Cmd/Ctrl+T` opens a tab, `Cmd/Ctrl+1` through `9`
  jump to one, and `Cmd/Ctrl+Shift+[` and `]` step between them. `Cmd/Ctrl+W` closes the tab you are
  on, and closes the window once it is the last tab. You can also reach the strip with `Tab`, move
  with the arrow keys, and close a tab with `Delete`. The `×` on a tab closes it too
- Your desktop tabs come back after a reload, and each window keeps its own set
- "Open in New Tab" in the command palette opens an agent without losing the one you were reading.
  In the desktop app that is a DorkOS tab; in a browser it is a browser tab, which you can bookmark
  or drag onto a second screen yourself
- The desktop app's command palette also has "Open in New Window", which opens a second DorkOS
  window on the agent you picked. Handy for a second screen. A browser has no separate answer to
  that, so the choice is not offered there

### Changed

- The desktop app keeps only the tab you are looking at connected to its agent. Background tabs let
  go, then pick the conversation back up with nothing missed the moment you return. A window full of
  tabs costs no more than one
- On the desktop app, the Window menu now says "Close Tab" for `Cmd/Ctrl+W`, because that is what it
  does. "Close Window" still closes the whole window
