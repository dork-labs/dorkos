---
covers:
  - 'feat(marketplace): report dev links in doctor and deep health (DOR-2696)'
  - 'feat(marketplace): dorkos marketplace link and unlink (DOR-2696)'
  - 'fix(marketplace): bind a terminal yes to the preview it answered (DOR-2696)'
---

### Added

- Run a plugin or skill pack from a folder on your computer with `dorkos marketplace link <path>` (DOR-2696). It shows the package, the folder, everything it runs and what it replaces, then asks before linking. If the folder changes while it asks, nothing is linked.
- Switch back with `dorkos marketplace unlink <name>`. Your installed copy comes back, or the package is removed. Your folder is never touched.
- `dorkos marketplace installed` marks each dev link with its folder, and says when the folder is gone. `dorkos doctor` lists your dev links and names any that need a look, with the command that fixes it.
