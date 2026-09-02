---
covers:
  - 'feat(server,client,shared): the workspaces page shows your real worktrees (DOR-1056)'
---

### Changed

- The Workspaces page now shows the copies of your code that actually exist. It reads your workspaces folder directly, so the worktrees your agents really work in finally show up, grouped by project, with the branch, how many files hold unsaved edits, how far ahead of or behind the remote each one is, and when it last got a commit. Before this, the page could only list copies DorkOS had made itself, and it had never made one, so it sat empty while dozens of real worktrees sat in the very same folder (DOR-1056)
- The page only reads. It never creates, changes, or deletes a copy, so a stray click can't take a folder out from under a running agent (DOR-1056)
- It also refuses to guess. A copy whose branch was merged and deleted says so, rather than claiming it's in sync with a branch that no longer exists. A folder DorkOS can't read still gets a row marked "Can't read" instead of quietly disappearing, and if a whole folder or the scan itself fails, you're told the list is incomplete instead of being shown an empty page that means "you have none" (DOR-1056)
