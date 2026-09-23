---
covers:
  - 'refactor(server): share the GitHub token rewrite as withGitHubToken (DOR-2248)'
  - "feat(server): fetch exactly one verified commit's tree from a git remote (DOR-2248)"
  - 'fix(server): cache a package under the commit its checkout holds (DOR-2248)'
  - 'refactor(server): keep git-tree internals unexported (DOR-2248)'
---

### Fixed

- A marketplace package now installs the branch, tag or exact commit its listing names. Before, many installs quietly took the repository's newest code instead, and a package pinned to a commit or kept on another branch could fail to install. (DOR-2248)
- The commit DorkOS records for an installed package is now always the code that was actually installed, so the version shown and the update check can be trusted. (DOR-2248)
- A package kept in one folder of a larger repository now installs even when that repository's default branch has another name, like `master`. (DOR-2248)
- When a branch, tag or commit doesn't exist, the install stops with a plain message saying so, before anything is downloaded. (DOR-2248)
