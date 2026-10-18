---
covers:
  - 'fix(server): a harmless failed command no longer wakes an agent for an extra check'
---

### Fixed

- Agents no longer wake up for an extra check every time a command fails during normal work, like a search that finds nothing. They still wake when something is really wrong: the disk is full, they can't write their own files, or the same command keeps failing.
