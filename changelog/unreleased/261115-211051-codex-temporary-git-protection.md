---
covers:
  - 'fix(runtime): preserve worktree access and task discovery (DOR-4485, DOR-4495)'
---

### Fixed

- Restore project discovery and Git status in worktrees created by Codex (DOR-4486).
- Keep Codex from changing Git’s own files below Full access, even in temporary folders (DOR-4485).
- Keep saved sign-ins protected inside Git’s own folders, including at Full access (DOR-4485).
- Pick up scheduled tasks whose folders arrive together, even when a file notice is missed (DOR-4495).
- Task file updates show the correct source in the audit log (DOR-4495).
