---
covers:
  - "fix(harness,server): one package's malformed hooks.json can no longer take down the whole projection (DOR-646)"
---

### Fixed

- One package with a broken hooks file no longer stops every other package from reaching your coding tools. Syncing used to fail outright on it, so nothing got set up — not that package's skills and commands, and not anyone else's either. DorkOS now skips only the parts of that file it cannot read, keeps the parts it can, and sets up every other package as usual. It also means the install screen and the sync now agree: the commands you were shown a package would run are exactly the ones that get set up (DOR-646)
