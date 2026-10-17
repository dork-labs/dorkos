---
covers:
  - "feat(memory): one memory per agent: notes files, memory_read, and Claude Code's own memory off on agent turns"
---

### Added

- Agents can now keep **notes files** for things too long for their main memory file, like a checklist or how a tricky part of a project works. Each new notes file gets a one-line description, and an agent opens one only when it needs it, so notes cost nothing until they are used. They live in `.dork/memory/` next to the main file, and are never committed to git.

### Changed

- When an agent runs in DorkOS, Claude Code's own memory is now switched off, so the agent keeps one memory instead of two. Before, its notes could end up split between the two. An agent that already has notes in Claude Code's memory keeps using them until they are copied over, so nothing goes missing.
