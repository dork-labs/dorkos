---
covers:
  - "feat(marketplace): resolve a package's version the way Claude Code does (DOR-2244)"
  - 'feat(marketplace): fail validation when manifest and plugin.json versions disagree (DOR-2244)'
  - 'feat(marketplace): name the place a package is fetched from with one normalizer (DOR-2244)'
  - 'feat(server): record where a package came from and its real version at install (DOR-2244)'
  - 'feat(server): resolve what installing a package now would give, without installing (DOR-2244)'
  - 'feat(server): list installed packages at the version they declare, never gated on validity (DOR-2244)'
  - 'fix(server): make the update check report new versions honestly (DOR-2244, DOR-2251)'
  - 'fix(server): answer 404 for an update of a package installed nowhere, and look again after a refresh (DOR-2244)'
  - 'fix(cli): check every package in its own scope and never claim all are up to date (DOR-2244)'
  - "fix(client): say when an update check couldn't run instead of 'already up to date' (DOR-2244)"
  - 'feat(cli): report a marketplace entry version that plugin.json silently overrides (DOR-2244)'
  - 'fix(marketplace): address review of the honest update check (DOR-2244)'
---

### Fixed

- `dorkos update` and the Update button now notice new versions of marketplace packages. Before, they always said everything was up to date. (DOR-2244)
- When DorkOS can't check a package for an update, it says so and why (for example, "couldn't reach github.com"). It no longer calls that package up to date.
- `dorkos update` with no package name now checks every package where it is installed, including packages installed for one agent. A problem with one package no longer stops the rest, and naming a package that isn't installed still ends with an error.
- The installed list now shows the version Claude Code actually runs, even for a package whose own files disagree about its version.

### Changed

- DorkOS no longer installs a package whose `.dork/manifest.json` and `.claude-plugin/plugin.json` state different versions, and says which file says what. Packages you already have stay installed and can still be updated or removed.
- `dorkos marketplace validate` now fails when a marketplace entry lists a version that the package's own `plugin.json` contradicts, since Claude Code would quietly ignore the entry's.
