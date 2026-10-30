---
covers:
  - "fix(server): a yes to a package's hooks covers the exact scripts they run (DOR-3403)"
---

### Fixed

- When you let an installed package run commands automatically, that yes used to cover only the command line. If the package then changed the script the command runs, the new code ran without asking you. Now the yes covers the exact file you were shown, and the card names each file with a short fingerprint you can check. If a file changes afterwards, DorkOS asks you again. On the Full setting nothing new asks, as before.
