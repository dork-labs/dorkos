---
covers:
  - "refactor(marketplace): one shared predicate for the install engine's sibling directories (DOR-2273)"
  - 'fix(marketplace): restore an interrupted install instead of deleting its backup (DOR-2273)'
  - 'fix(marketplace): close the review gaps in install crash recovery (DOR-2273)'
  - 'fix(marketplace): watcher skip, later-made targets, and uninstall candidate order (DOR-2273)'
  - "fix(marketplace): read lstat lazily in install recovery's test seam (DOR-2273)"
---

### Fixed

- If DorkOS stops in the middle of installing a package over an older version, you get the older version back. Before, a crash at the wrong moment could leave you with neither version, because DorkOS later deleted the saved copy of the old one instead of putting it back. (Updating a package is not covered yet; that fix is on its way.)
- A package that was half-installed when DorkOS stopped is cleaned up the next time DorkOS starts, instead of showing up broken. If you have since put something of your own in its place, DorkOS leaves it alone.
- When two copies of DorkOS work on the same project, one no longer undoes an install the other is still in the middle of. If you try to install a package while the other copy is installing it, DorkOS tells you how many minutes to wait.
- A leftover saved copy of a package no longer shows up as a second copy of it: not as a second Shape, not as a second agent in the health check, not as extra skills for your coding agents, and not as a second copy of a scheduled task.
