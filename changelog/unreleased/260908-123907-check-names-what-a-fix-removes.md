---
covers:
  - 'fix(harness): --check names everything a --fix would remove (DOR-1889)'
---

### Fixed

- `dorkos harness sync --check` now lists every file a `--fix` would remove, not just the broken skill links. Uninstall a package and the check names the links, slash commands, hooks files and settings entries it left behind — before you run the command that deletes them (DOR-1889)
- A project is no longer called clean when a sync would delete files in it. Removing a package used to leave the check saying "no drift" while the next sync quietly took nine files out of the project (DOR-1889)
