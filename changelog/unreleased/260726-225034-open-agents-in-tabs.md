---
covers:
  - 'feat(client): open agents in tabs instead of new windows (DOR-540)'
---

### Added

- Open your agents in tabs, the way you already work in a browser or an editor. The tab strip sits
  across the top of the window; the `+` button opens another one, and "Open in New Tab" in the
  command palette now really does open a tab instead of a whole new window (DOR-540)
- Tabs stay honest about what your agents are doing while you are not looking. A tab lights up when
  its agent starts working, needs an answer from you, or hits an error — so you can leave five
  agents running and glance at the strip to see which one wants you
- Keyboard shortcuts for tabs in the desktop app: `Cmd/Ctrl+T` for a new tab, `Cmd/Ctrl+1` through
  `9` to jump to one, and `Cmd/Ctrl+Shift+[` / `]` to step between them. `Cmd/Ctrl+W` closes the
  tab you are on, and still closes the window when it is the last one. In the browser those keys
  belong to the browser, so use the strip: `Tab` reaches it, and the arrow keys move between tabs
- Your tabs come back after a reload, and each window keeps its own set

### Changed

- Only the tab you are looking at stays connected to its agent. Background tabs let go and pick the
  conversation back up — with nothing missed — the moment you return, so a wall of tabs costs no
  more than one
