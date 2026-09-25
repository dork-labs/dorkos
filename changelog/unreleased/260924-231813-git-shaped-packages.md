---
covers:
  - 'fix(security): refuse git-shaped packages and harden every git DorkOS and its agents run (DOR-2326)'
  - "fix(security): keep people's hooks, strip package .git, warn below git 2.38 (DOR-2326)"
---

### Security

- A folder can no longer make git run a program just because DorkOS or one of your agents looked inside it. A folder set up to look like a git repository can carry a setting that tells git to run a program. Now every time DorkOS or an agent runs git, git ignores the settings of a repository it only stumbled on, and never starts a file-watching helper. DorkOS refuses to install a marketplace package shaped like a git repository, and drops any `.git` folder a package brings with it. Your own repositories work as before, and your git hooks still run when you or an agent commits. Two trade-offs: git in a very large repository that relied on a file-watching helper checks for changes the slower way, and an agent working inside a bare repository must name it with `--git-dir`. Full protection needs git 2.38 or later. DorkOS warns at startup and in `dorkos doctor` when yours is older. (DOR-2326)
