---
covers:
  - 'fix(desktop): supervise the server process with explicit lifecycle state (DOR-533)'
---

### Fixed

- The Mac and Windows apps now tell you when their background server stops, instead of quietly
  going dead. Before, the app could keep showing a window that no longer talked to anything —
  most visibly after "Reset All Data" — with nothing on screen to say why (DOR-533)
- Quitting the desktop app no longer hangs for five seconds after the server has stopped (DOR-533)
- The desktop app no longer sits at a blank screen forever when its server fails to start. It
  now says what went wrong and closes (DOR-533)
- Running the desktop app in development no longer reads and writes your real DorkOS data, and
  no longer leaves a stray server running in the background after you close it (DOR-533)
