---
covers:
  - 'fix(agents): a chat in a git submodule checks its repo settings like any other repo (DOR-5244)'
---

### Fixed

- Below Full, a chat in a git submodule, a worktree of one, or a repo that holds submodules checks its hooks and settings against that repo's default branch and asks you about changes, like any other repo (DOR-5244).
- Below Full, local settings in a folder above an agent's home wait for your approval even when that folder's `.git` file is broken (DOR-5244).
