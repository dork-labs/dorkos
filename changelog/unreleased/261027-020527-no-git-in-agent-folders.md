---
covers:
  - "fix(server): DorkOS no longer runs git in an agent's own folders (DOR-3343)"
  - 'fix(server): the Workspaces scan and the file list skip git in agent folders too (DOR-3343)'
  - 'fix(server): git stays off in a project whose worktree an agent works in (DOR-3343)'
---

### Fixed

- DorkOS no longer runs git in folders an agent can change: agent homes, workspaces, worktrees and rooms, and projects that have a worktree in one of those. For now, chats in those folders don't show the git branch, the diff view can't compare with the last commit there, the file list there doesn't skip ignored files, the Workspaces page shows those checkouts as unreadable, and heartbeats skip new commits and failing checks. A safer way to read git in those folders comes next. (DOR-3343)
