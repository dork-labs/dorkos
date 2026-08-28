---
covers:
  - 'feat(desktop,client): the window that cannot stay black — renderer supervision and recovery (DOR-1453)'
---

### Fixed

- If the DorkOS app's screen ever fails to come up, the app now notices and
  fixes itself. It waits ten seconds for the window to draw; if nothing
  appears, it reloads. If that doesn't work it clears what the window has
  saved and reloads again, and after that it offers to restart DorkOS with
  graphics acceleration turned off — and asks first if your agents are still
  working, so nothing is interrupted without you. It counts across restarts,
  so a window that breaks every single launch still gets each of those tried
  once. Before this, a window that came up black simply stayed black: nothing
  retried it, nothing recovered it, and nothing wrote down what went wrong
  (DOR-1453)
- The "DorkOS couldn't start" message used to tell you to check a folder that
  only exists on a Mac. It now names the folder on the computer you are
  actually using
- The check that runs before every desktop release now opens the app and
  confirms its window really drew something. It used to check that the app
  started, answered, and closed cleanly — all of which a black window does
  perfectly well (DOR-1453)

### Added

- When DorkOS cannot get its screen working, it now shows you a page that
  says so instead of leaving you with a black rectangle. It offers you three
  things: start over, reset the window and restart, or save a report you can
  send us. Your projects, your sessions and your agents are not touched by
  any of them — they live on your computer, not in that window (DOR-1453)
