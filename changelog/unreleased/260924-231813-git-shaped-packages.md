---
covers:
  - 'fix(security): refuse git-shaped packages and harden every git DorkOS and its agents run (DOR-2326)'
---

### Security

- A package can no longer run a program just because git is used in its folder. A folder that looks like a git repository can carry settings telling git to run a program whenever it checks that folder. DorkOS now refuses to install a package shaped like that, and every time DorkOS or one of your agents runs git, git ignores those settings in folders it only stumbles on. Your own repositories work as before, and your agents still run your git hooks. (DOR-2326)
