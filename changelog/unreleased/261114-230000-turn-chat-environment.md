---
covers:
  - "feat(runtimes): every runtime's turn env carries the DorkOS chat id (DORKOS_SESSION_ID)"
---

### Added

- Agents on Claude Code, Codex, OpenCode and the Dork runtime can now tell which DorkOS chat they're in: their commands and hooks get `DORKOS_SESSION_ID` (DOR-4380).
