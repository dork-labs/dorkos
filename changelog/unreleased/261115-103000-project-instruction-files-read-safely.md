---
covers:
  - 'fix(runtimes): project instruction files are read only as regular files, never through a symlink, and cut to a fixed size (DOR-4405)'
---

### Fixed

- When DorkOS passes a project's `AGENTS.md` or `CLAUDE.md` to an agent, it now reads only real files. A link pointing somewhere else on your computer is skipped. A very long file is cut short, with a note saying so, so it can't crowd out the agent's own instructions.
