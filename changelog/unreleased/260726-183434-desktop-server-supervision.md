---
covers:
  - 'fix(desktop): supervise the server process with explicit lifecycle state (DOR-533)'
  - "fix(desktop): watch the shell's pid so an orphaned dev server actually dies (DOR-533)"
---

### Fixed

- The Mac app now tells you when the background server it runs has stopped, and offers to start
  it again. Before, the window stayed open but quietly stopped working — most noticeably right
  after "Reset All Data" — with nothing on screen to explain why (DOR-533)
- Quitting the Mac app no longer pauses for several seconds when that server has already stopped
  (DOR-533)
- When the Mac app can't start its server at all, it now says so and closes, instead of leaving
  you with no window and no message (DOR-533)
