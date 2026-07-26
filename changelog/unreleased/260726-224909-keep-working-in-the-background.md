---
covers:
  - 'feat(desktop): keep working in the background, with a tray to get back (DOR-538)'
  - 'fix(desktop): keep the update restart out of the background notice (DOR-538)'
---

### Added

- The desktop app keeps running when you close its window, so your agents carry on working (DOR-538)
- A DorkOS icon in the macOS menu bar shows how many agents are working, and brings the window back (DOR-538)
- The first time you close the window, DorkOS tells you it is still running, and offers to quit if that is what you meant (DOR-538)
- Quitting while agents are mid-task now asks first: "3 agents are still working. Quit anyway?" (DOR-538)
- "Open in New Tab" opens a second DorkOS window instead of sending you to your web browser (DOR-538)

### Fixed

- The desktop app no longer flashes a white rectangle before it loads (DOR-538)
- A window left on a monitor you then unplug comes back to a screen you can see, without a restart (DOR-538)
- Quitting while full screen no longer brings the window back jammed under the menu bar (DOR-538)
