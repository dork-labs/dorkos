---
covers:
  - 'feat(marketplace): flag a linked install on the installed listing (DOR-2193)'
  - 'feat(cli): make dorkos marketplace the home for package management (DOR-2193)'
  - 'docs(cli): document the marketplace package commands (DOR-2193)'
---

### Added

- See what you have installed from the terminal with `dorkos marketplace installed`. Each row says where the package lives (everywhere, or which agent), and marks a package that points at a working copy on your computer. (DOR-2193)
- See which packages are behind with `dorkos marketplace outdated`. It only prints what has an update, plus anything it couldn't check, and changes nothing. Its exit code tells a script or a scheduled job what it found: `0` all up to date, `1` something has an update, `2` it couldn't tell. (DOR-2193)

### Changed

- All marketplace commands now live under `dorkos marketplace`: `install`, `update` and `uninstall` join `installed`, `outdated` and the source commands. `dorkos install`, `dorkos update` and `dorkos uninstall` still work as shorter names for the same commands. (DOR-2193)
