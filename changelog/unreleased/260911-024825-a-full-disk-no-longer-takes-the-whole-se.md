---
covers:
  - 'fix(tasks): a full disk no longer takes the whole server down (FB-17)'
---

### Fixed

- Running out of disk space no longer shuts DorkOS down mid-conversation. It now keeps going, hands scheduled tasks to another DorkOS process if one is running, and writes a line in the log telling you the disk is full. It picks scheduling back up on its own once you free some space.
