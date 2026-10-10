---
covers:
  - "fix(agents): agent files nobody edited catch up with today's starter text (DOR-2779)"
---

### Fixed

- Agents made before this update stop calling themselves assistants. If you never changed an agent's `SOUL.md`, or DorkBot's `AGENTS.md`, DorkOS swaps in the current starter text the next time it starts. Any file you edited, even by one character, stays exactly as you left it (DOR-2779)
