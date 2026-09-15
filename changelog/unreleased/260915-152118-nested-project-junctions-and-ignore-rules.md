---
covers:
  - 'fix(harness): a project inside a bigger checkout is told about its junctions and its ignore rules (DOR-1957)'
---

### Fixed

- Say what git will do with the files DorkOS writes when your project sits inside a bigger repository. A package in a monorepo — or any `dorkos harness sync` run from a folder below the one holding the `.git` — was treated as if it were not in git at all: on Windows nobody was warned that the skill links there get committed as copies of the files rather than as links, and the `.gitignore` check stayed silent. DorkOS now looks upward for the repository, reads the ignore rules from there down to your project the way git does, and names the file you would open to change one — `../../.gitignore` when that is the one deciding (DOR-1957)
