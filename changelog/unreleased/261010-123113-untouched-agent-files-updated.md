---
covers:
  - "fix(agents): agent files nobody edited catch up with today's starter text (DOR-2779)"
  - "fix(agents): refresh a SOUL.md only when its name is the agent's own (DOR-2779)"
---

### Fixed

- Older agents stop calling themselves assistants. If an agent lives in DorkOS's own folder and you never changed its `SOUL.md`, or DorkBot's `AGENTS.md`, DorkOS swaps in the new starter text the next time it starts. A file you edited, even by one character, stays exactly as you left it (DOR-2779)
