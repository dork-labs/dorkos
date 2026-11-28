---
covers:
  - "feat(runtimes): put the owner's own folders first on PATH in every runtime's turn"
---

### Added

- Put your own folders first on `PATH` when agents run commands, on every runtime (Claude Code, Codex, OpenCode and Dork), with the new `runtimes.environment.pathPrepend` setting. It starts empty, so nothing changes until you add a folder, and agents can't change it.
