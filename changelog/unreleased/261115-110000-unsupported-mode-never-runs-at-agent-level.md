---
covers:
  - 'fix(sessions): a chat set to a mode its runtime doesn’t have is refused, and never runs at the agent’s level (DOR-4411)'
  - 'fix(sessions): an unknown mode under a ceiling below every trust mode keeps the old fallback (DOR-4411)'
---

### Fixed

- Setting a chat to a mode its runtime doesn't have, such as Plan on a Codex chat, is now refused with a clear message. Before, DorkOS accepted it, and the chat's first turn could run at its agent's full level instead. A chat that already had such a mode stored now starts in its runtime's most careful mode.
- A Codex, DOE or OpenCode chat that had Plan, Auto or Don't ask saved now runs in that runtime's most careful mode. On Codex, that means it can only read.
