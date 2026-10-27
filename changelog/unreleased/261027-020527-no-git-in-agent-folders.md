---
covers:
  - "fix(server): DorkOS no longer runs git in an agent's own folders (DOR-3343)"
---

### Fixed

- DorkOS no longer runs git in folders an agent can change: agent homes, workspaces, worktrees and rooms. For now, chats in those folders don't show the git branch, the diff view can't compare with the last commit there, and heartbeats skip new commits and failing checks. A safer way to read git in those folders comes next. (DOR-3343)
