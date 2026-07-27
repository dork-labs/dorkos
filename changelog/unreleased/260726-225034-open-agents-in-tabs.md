---
covers:
  - 'feat(client): open agents in tabs instead of new windows (DOR-540)'
  - 'fix(client): only a history traversal may move focus between tabs (DOR-540)'
  - 'fix(client): answer the shell truthfully when Cmd+W closes a tab (DOR-540)'
---

### Added

- Open your agents in tabs, the way you already work in a browser or an editor. The tab strip runs
  across the top of the window. The `+` button opens another tab, and "Open in New Tab" in the
  command palette now opens a tab instead of a whole new window (DOR-540)
- Tabs tell you what your agents are doing while you are looking somewhere else. A tab lights up
  when its agent starts working, needs an answer from you, or hits a problem. You can leave five
  agents running and glance at the strip to see which one wants you
- The command palette also has "Open in New Window", which opens a second DorkOS window on the
  agent you picked. Handy for a second screen
- Keyboard shortcuts for tabs in the desktop app: `Cmd/Ctrl+T` opens a tab, `Cmd/Ctrl+1` through `9`
  jump to one, and `Cmd/Ctrl+Shift+[` and `]` step between them. `Cmd/Ctrl+W` closes the tab you are
  on, and closes the window once it is the last tab. Web browsers keep most of these keys for their
  own tabs, so in the browser use the strip instead. Press `Tab` to reach it, arrow keys to move
  between tabs, and `Delete` to close one. The `×` on a tab closes it anywhere
- Your tabs come back after a reload, and each window keeps its own set

### Changed

- Only the tab you are looking at stays connected to its agent. Background tabs let go, then pick
  the conversation back up with nothing missed the moment you return. A wall of tabs costs no more
  than one
- On the desktop app, the Window menu now says "Close Tab" for `Cmd/Ctrl+W`, because that is what it
  does. "Close Window" still closes the whole window
