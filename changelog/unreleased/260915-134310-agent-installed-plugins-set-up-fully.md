---
covers:
  - 'fix(marketplace): a plugin an agent installs is set up the same as one installed from the app (DOR-2057)'
---

### Fixed

- A plugin your agent installs for you now works right away, the same as one you install from the app. Before, its files arrived but its commands and skills never showed up for the agent. Removing a plugin through an agent now cleans those up too (DOR-2057)
