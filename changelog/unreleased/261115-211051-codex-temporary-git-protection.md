---
covers:
  - 'fix(runtime): restore workspace reads and task discovery (DOR-4485)'
---

### Fixed

- Restore project discovery and Git status in worktrees created by Codex (DOR-4486).
- Keep Codex from changing Git’s own files below Full access, even in temporary folders (DOR-4485).
- Keep saved sign-ins protected inside Git’s own folders, including at Full access (DOR-4485).
- Codex refuses unsupported Git folders before starting on Linux (DOR-4485).
- Pick up scheduled tasks whose folders arrive together, even when a file notice is missed (DOR-4495).
- Task file updates show the correct source in the audit log (DOR-4495).
- Keep running task clocks unchanged when a folder notice triggers a rescan (DOR-4495).
- Avoid delays when moving a skill between agent tools (DOR-4514).
