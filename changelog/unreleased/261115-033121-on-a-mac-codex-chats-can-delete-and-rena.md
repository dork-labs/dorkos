---
covers:
  - 'fix(codex): on a Mac, Codex chats can delete and rename folders again, and npm runs (DOR-4358)'
  - 'fix(codex): read tracked .npmrc files through the audited git runner (DOR-4358)'
---

### Fixed

- On a Mac, a Codex chat can delete and rename folders in its project again. Before, removing any folder failed with "Operation not permitted", so test setup, `npm ci` and reinstalls broke. Files that hold sign-ins and keys stay unreadable, and can't be moved or linked to get around that.
- npm and pnpm now run in a Codex chat. They no longer stop on your `~/.npmrc`, which stays out of the agent's reach, and a project `.npmrc` checked into git can be read.
- In a Codex chat on a Mac, `git` can check `~/.ssh/known_hosts`. The keys beside it stay unreadable, and the file can't be changed.
