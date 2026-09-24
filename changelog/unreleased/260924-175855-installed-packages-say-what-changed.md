---
covers:
  - 'feat(server): verify an install against its installed-files record (DOR-2197)'
  - "feat(server): rebuild a legacy install's record only from an exact match (DOR-2197)"
  - 'feat(server): give older installs an exact record in the background after boot (DOR-2197)'
  - 'feat(server): list installs with their integrity when asked (DOR-2197)'
  - "feat: prepare a package an older DorkOS installed, from the app's API or the CLI (DOR-2320, DOR-2197)"
  - 'feat: dorkos doctor --deep says which installed packages changed or need preparing (DOR-2197)'
  - "feat(client): the Installed view says when a package's files changed, and prepares older installs (DOR-2197, DOR-2320)"
  - 'feat(server): the legacy record sweep stops on shutdown, and boot clears its leftovers (DOR-2197)'
  - 'fix(server): the strict record rebuild proves the whole install, and trusts no old userEditable (DOR-2197)'
  - 'feat(client): the files note opens to its paths and says what an update does to each kind (DOR-2197, DOR-2320)'
  - 'refactor: prepare is now Check files, in the API, the app and the CLI (DOR-2197, DOR-2320)'
  - 'fix(tasks): the older-install refusals point at Check files (DOR-2197, DOR-2320)'
---

### Added

- The **Installed** tab says when a package's files changed since it was installed, for example **3 files changed since install (2 edited, 1 added)**. Open it to see which files. When an update is waiting, it also says what the update will do: replace files you edited and keep your copies, keep files you added, and put back files you removed. **Update all…** says the same for each package (DOR-2197)
- `dorkos marketplace installed --verify` adds a FILES column saying whether each package is as installed, changed, or unknown, and `dorkos doctor --deep` names the packages that changed or that an older DorkOS installed (DOR-2197)
- Packages an older version of DorkOS installed are checked in the background after DorkOS starts: their files are recorded only when every file still matches the exact version you installed, and nothing is touched otherwise. **Check files** in the Installed tab, or `dorkos marketplace check-files <name>`, tries again, and says why when it can't help. Scheduling work for an agent from such a package now points you there instead of telling you to wait for its next update (DOR-2197, DOR-2320)
