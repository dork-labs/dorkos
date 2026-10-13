---
covers:
  - 'perf(server): watch chat folders, not every chat file, on macOS (DOR-2907)'
---

### Fixed

- On macOS, DorkOS no longer keeps a file open for every chat on your computer just to notice when one changes. It held hundreds open at once, which could run into the system's limit on open files. Now it watches the folders instead, and checks once a minute for any change it missed (DOR-2907)
