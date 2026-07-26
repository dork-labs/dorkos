---
covers:
  - 'feat(desktop): keep working in the background, with a tray to get back (DOR-538)'
---

### Added

- The desktop app keeps running when you close its window, so your agents carry on working. A small DorkOS icon in the macOS menu bar brings it back, opens Activity, or quits — and it shows how many agents are working right now. The first time you close the window, DorkOS says plainly that it is still running, and offers to quit if that is what you meant (DOR-538)
- Quitting while agents are mid-task now asks first: "3 agents are still working. Quit anyway?" Nothing running, no question (DOR-538)
- "Open in New Tab" opens a second DorkOS window instead of sending you to your web browser. Links to other sites still open in your browser, where they belong (DOR-538)
- `Cmd+W` closes a tab rather than the whole window. `Shift+Cmd+W` still closes the window (DOR-538)

### Fixed

- The desktop app no longer flashes a white rectangle before it loads (DOR-538)
- A window left on a monitor you then unplug comes back to a screen you can actually see, straight away rather than only after a restart. And quitting from full screen no longer brings the window back jammed under the menu bar (DOR-538)
