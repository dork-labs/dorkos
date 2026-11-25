---
covers:
  - 'fix(codex): start in a folder like site [old] and in a worktree whose Git folder is gone, with Git files still protected (DOR-4542)'
  - 'fix(codex): refuse a folder with a backslash in its path, which Codex reads as an escape (DOR-4542)'
---

### Fixed

- Codex starts again at every level in a folder whose path has `* ? [ ] { }` in it, like `site [old]`, and in a worktree whose Git folder is gone. Below Full, Codex still can't change the folder's Git files, and secret files such as `.env` in the folder stay unreadable (DOR-4542).
- When Codex won't start in a folder, the message now says why: the folder is inside a Git folder, a worktree's missing Git folder could be made again by the chat, or, on Linux, the Git files sit inside a protected folder. A folder with a backslash (`\`) in its path is refused at every level, because Codex can't tell its secret files from a look-alike folder's.
