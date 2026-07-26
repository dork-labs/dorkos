---
covers:
  - 'fix(desktop): supervise the server process with explicit lifecycle state (DOR-533)'
  - "fix(desktop): watch the shell's pid so an orphaned dev server actually dies (DOR-533)"
  - 'fix(desktop): show what the server said, and stop offering a restart that keeps failing (DOR-533)'
---

### Fixed

- The Mac app now tells you when the background server it runs has stopped, and offers to start
  it again. Before, the window stayed open but quietly stopped working — most noticeably right
  after "Reset All Data" — with nothing on screen to explain why (DOR-533)
- When that server won't start, the Mac app now tells you what the server said about why, then
  closes. If you already have DorkOS running in a terminal, for instance, it says so — instead of
  showing a bare error code and leaving the real explanation in a log file (DOR-533)
- If starting the server keeps failing, the Mac app stops offering a button that isn't working
  and offers to open its logs instead (DOR-533)
- Quitting the Mac app no longer pauses for several seconds when its server has already stopped
  (DOR-533)
