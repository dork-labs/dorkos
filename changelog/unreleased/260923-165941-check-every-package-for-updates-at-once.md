---
covers:
  - 'refactor(shared): share the ordered promise pool (DOR-2194)'
  - "refactor(marketplace): one scan yields each installation's record (DOR-2194)"
  - 'fix(marketplace): check every installation, and update each where it is (DOR-2194)'
  - 'feat(marketplace): check and apply updates across every installed package in one request (DOR-2194)'
  - 'feat(cli): a name-less dorkos update is one request (DOR-2194)'
  - 'fix(marketplace): update exactly what was checked, in the scope it touches (DOR-2194)'
---

### Added

- `dorkos update` checks every package you have installed in one go. That includes packages installed for a single agent. A package installed in two places now shows up as two lines, each saying where it lives, like `flow [Alpha]`. With `--apply`, it lists what it updated and anything it couldn't update, with the reason. Programs can ask the same question with `GET /api/marketplace/updates` and apply updates with `POST /api/marketplace/updates`, either for named packages or for exactly the installations a check listed. A package folder you linked in from your own copy is checked but never replaced; its line says to update the source instead (DOR-2194)

### Fixed

- Updating a package with `--project` no longer moves a package that is installed for everything into that one project. Each package is now updated where it is installed (DOR-2194)
