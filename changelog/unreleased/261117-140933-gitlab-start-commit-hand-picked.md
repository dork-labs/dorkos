---
covers:
  - "fix(connections): a GitLab commit started from another commit or project needs the agent's own grant, like a new branch (DOR-4507)"
---

### Fixed

- A GitLab commit that starts from another commit or another project now needs to be given to that agent on its own, the same as one that starts a new branch. Read and write no longer covers it.
