---
covers:
  - 'fix(claude-code): tell the truth about a gated tool on reload and to extensions'
---

### Fixed

- Reloading the page while a tool is waiting for your approval no longer shows it as already done. The live view was fixed first; rebuilding the conversation from its saved history still showed a finished tool, so a refresh mid-decision put the old answer back on screen.
- Extensions are no longer told a tool finished while you are still being asked whether to allow it.
