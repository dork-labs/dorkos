---
covers:
  - 'docs(specs): specify marketplace package cache retention (DOR-2249)'
  - 'feat(marketplace): give the package cache a retention owner (DOR-2249)'
  - 'docs(marketplace): document package cache retention (DOR-2249)'
  - 'fix(marketplace): never follow a symlink when sizing a tree; stamp best-effort; keep a staged update beside a re-read install (DOR-2249)'
  - 'fix(marketplace): read what installs record strictly, and record project installs (DOR-2249)'
  - 'fix(marketplace): keep a fresh project-install record, recover a corrupt one, and show a paused cleanup (DOR-2249)'
  - "fix(marketplace): skip the install engine's own siblings when reading what installs record (DOR-2249)"
---

### Changed

- DorkOS now tidies its store of downloaded marketplace packages on its own. After each download it keeps what your installed packages need, plus an update that is waiting to be installed, and removes the rest. Before, the store only grew, and checking for updates often would have filled your disk over time. (DOR-2249)
- If DorkOS can't read one of your projects, for example on a drive that isn't plugged in, it removes nothing from the store until it can, and `dorkos cache list` tells you why. (DOR-2249)
- `dorkos cache prune` now follows the same rule and no longer takes `--keep-last-n`. The old option could delete the exact copy an installed package came from. (DOR-2249)
