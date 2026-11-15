---
covers:
  - 'fix(runtimes): run package safety checks on OpenCode and the DorkOS runtime (DOR-4379)'
---

### Fixed

- Safety checks from installed packages, like Safety Hooks, now stop risky shell commands such as `git stash` and `pkill` for agents on OpenCode and the DorkOS runtime too, in every mode. They don't run on Codex yet, and the install screen and the runtime picker now say so. (DOR-4379)
