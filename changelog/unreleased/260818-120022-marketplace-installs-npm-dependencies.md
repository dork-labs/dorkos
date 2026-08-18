---
covers:
  - "feat(server,client,shared): marketplace installs a package's npm dependencies, and the preview says so first (DOR-1341)"
  - 'feat(cli): `dorkos install` names the npm libraries it will download before you approve (DOR-1341)'
---

### Added

- Packages that need npm libraries now get them installed for you. When you install something from the Marketplace, DorkOS lists the libraries it will download before you approve — in the cockpit dialog and in the terminal — then fetches them as part of the install. No more running `npm install` by hand to make a plugin work (DOR-1341).

### Fixed

- If a package's libraries cannot be fetched — no npm on your machine, or the download fails — the package still installs and DorkOS tells you exactly what to run to finish the job, instead of failing silently or throwing the whole install away (DOR-1341).
