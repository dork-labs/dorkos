---
covers:
  - 'fix(codex): on a Mac, Codex chats can delete and rename folders and run npm again (DOR-4358)'
  - 'fix(codex): on a Mac, each protected file is refused by rules of its own (DOR-4358)'
  - 'fix(codex): on a Mac, size the named-file rules by the bytes Codex writes for them (DOR-4358)'
---

### Fixed

- On a Mac, a Codex chat can delete and rename folders in its project again. Before, removing a folder failed with "Operation not permitted", so test cleanup, `npm ci` and reinstalls broke. Files that hold keys and sign-ins stay unreadable, and can't be moved, deleted or linked to get around that. Linux is unchanged.
- npm and pnpm run in a Codex chat. They no longer stop on your `~/.npmrc`, which stays out of the agent's reach, and a project `.npmrc` checked into git can be read.
- In a Codex chat on a Mac, `git` can check `~/.ssh/known_hosts`. The keys beside it stay unreadable, and the file can't be changed.
- When a file that holds a secret appears in a Codex chat's folders during a turn, the Activity feed names it, and Codex keeps it out of reach from then on.
