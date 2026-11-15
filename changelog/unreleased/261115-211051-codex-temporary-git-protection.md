---
covers:
  - 'fix(workspaces): preserve Codex project access and protected git metadata (DOR-4485, DOR-4486)'
---

### Fixed

- Restore project discovery and Git status in worktrees created by Codex (DOR-4486).
- Keep Codex from changing Git’s own files below Full access, even in temporary folders (DOR-4485).
- Keep saved sign-ins protected inside Git’s own folders, including at Full access (DOR-4485).
