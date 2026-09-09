---
covers:
  - "feat(server): one key for a marketplace's repository (DOR-1921)"
  - 'feat(server): what Claude Code alone has, read and classified (DOR-1921)'
  - 'feat(cli): the plugins you turned on in Claude Code, named (DOR-1921)'
  - "feat(server): Claude Code's own plugins on the status answer (DOR-1921)"
  - 'fix(cli): the install offer names the project, not a dot (DOR-1921)'
  - "fix(server): one bad byte in Claude's settings costs one key (DOR-1921)"
  - 'fix(server): an unwalkable hook group is a line, not a quiet zero (DOR-1921)'
---

### Added

- `dorkos harness sync` now names the plugins you turned on in Claude Code, which your other agents cannot see. Each one comes with the repository it came from and the command that installs it here, named by your project's full path, so every agent on the project gets it. Nothing is installed for you, and the report says which settings file it read (DOR-1921)
- The same report says how many commands your personal Claude Code settings run on their own, and that only Claude Code runs them. If part of that file is written in a way DorkOS cannot read, it says which part rather than guessing at a number (DOR-1921)
