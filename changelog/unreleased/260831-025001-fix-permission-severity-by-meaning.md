---
covers:
  - 'fix(client): make the status bar judge a permission mode by what it does, not its name (DOR-820)'
---

### Fixed

- The Permissions status item now judges a mode by what it actually does, not by whether its name happens to be "default". Switching a session to its safest mode no longer shows a false warning just because that mode has a different name (DOR-820)
