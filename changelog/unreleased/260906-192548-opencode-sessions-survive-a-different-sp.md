---
covers:
  - 'fix(server): OpenCode sessions survive a different spelling of the same folder (DOR-695)'
  - 'fix(server): the session fan-out reconciles a symlinked project path (DOR-695)'
---

### Fixed

- OpenCode sessions no longer disappear from the session list when a project is opened through a different spelling of the same folder — through a symlink, with a trailing slash, or by way of a parent folder. They come back in the session list, in the sidebar's Recent list, and in the Activity counts. One place still misses them when the folder is reached through a symlink: the session picker matches folders in the browser, where it cannot check what a folder really is on disk. That half is coming separately. (DOR-695)
