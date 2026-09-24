---
covers:
  - 'feat(server): verify an install against its installed-files record (DOR-2197)'
  - "feat(server): rebuild a legacy install's record only from an exact match (DOR-2197)"
  - 'feat(server): give older installs an exact record in the background after boot (DOR-2197)'
  - 'feat(server): list installs with their integrity when asked (DOR-2197)'
  - "feat: prepare a package an older DorkOS installed, from the app's API or the CLI (DOR-2320, DOR-2197)"
  - 'feat: dorkos doctor --deep says which installed packages changed or need preparing (DOR-2197)'
  - "feat(client): the Installed view says when a package's files changed, and prepares older installs (DOR-2197, DOR-2320)"
---

### Added

- The **Installed** tab says when a package's files changed since it was installed (for example **3 files changed since install**, hover to see which), and what an update will do to them: replace them and keep your copies beside them. **Update all…** says the same for each package it affects (DOR-2197)
- `dorkos marketplace installed --verify` adds a FILES column saying whether each package is as installed, changed, or unknown, and `dorkos doctor --deep` names the packages that changed or need preparing (DOR-2197)
- Packages installed by an older version of DorkOS now get a record of which files are theirs, in the background after DorkOS starts. It's made only when every file still matches the exact version the package came from; otherwise nothing is touched. **Prepare** in the Installed tab, or `dorkos marketplace prepare <name>`, tries again and says why if it can't (DOR-2197, DOR-2320)
