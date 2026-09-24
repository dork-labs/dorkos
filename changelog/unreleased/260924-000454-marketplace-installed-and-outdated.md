---
covers:
  - 'feat(marketplace): flag a linked install on the installed listing (DOR-2193)'
  - 'feat(cli): make dorkos marketplace the home for package management (DOR-2193)'
  - 'docs(cli): document the marketplace package commands (DOR-2193)'
  - 'fix(cli): explain an older running DorkOS to marketplace outdated (DOR-2193)'
  - 'fix(cli): resolve --project locally, set linked installs apart in outdated (DOR-2193)'
---

### Added

- See what you have installed from the terminal with `dorkos marketplace installed`. Each row says where the package lives (everywhere, or which agent), and marks a package that points at a working copy on your computer. (DOR-2193)
- See which packages are behind with `dorkos marketplace outdated`. It only prints what has an update, plus anything it couldn't check, and changes nothing. Its exit code tells a script or a scheduled job what it found: `0` all up to date, `1` something has an update, `2` it couldn't tell. A package linked to a working copy is listed on its own and doesn't change the answer. (DOR-2193)

### Changed

- All marketplace commands now live under `dorkos marketplace`: `install`, `update` and `uninstall` join `installed`, `outdated` and the source commands. `dorkos install`, `dorkos update` and `dorkos uninstall` still work as shorter names for the same commands. (DOR-2193)

### Fixed

- `--project .` on `install`, `update` and `uninstall` now means the folder you're in, even when DorkOS was started somewhere else. Before, DorkOS could pick the wrong project or refuse the path. (DOR-2193)
- `dorkos update` now says to restart DorkOS when the running copy is older than the command, instead of a bare "Not found". (DOR-2193)
