---
covers:
  - "feat(server): one key for a marketplace's repository (DOR-1921)"
  - 'feat(server): what Claude Code alone has, read and classified (DOR-1921)'
  - 'feat(cli): the plugins you turned on in Claude Code, named (DOR-1921)'
---

### Added

- `dorkos harness sync` now names the plugins you turned on in Claude Code, which your other agents cannot see. Each one comes with the repository it came from and the command that installs it here, so every agent on the project gets it. Nothing is installed for you, and the report says which settings file it read (DOR-1921)
- The same report says how many commands your personal Claude Code settings run on their own, and that only Claude Code runs them (DOR-1921)
