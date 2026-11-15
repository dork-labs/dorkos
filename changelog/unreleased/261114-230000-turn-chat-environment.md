---
covers:
  - "feat(runtimes): every runtime's turn env carries the DorkOS chat id (DORKOS_SESSION_ID)"
  - 'fix(runtimes): a chat rekey keeps its warm Claude process, and the env tests carry no matrix id'
---

### Added

- Agents on Claude Code, Codex and the Dork runtime can now tell which DorkOS chat they're in: their commands and hooks get `DORKOS_SESSION_ID` (DOR-4380).
