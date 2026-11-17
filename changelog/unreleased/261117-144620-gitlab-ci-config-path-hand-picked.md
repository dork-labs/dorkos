---
covers:
  - "fix(connections): moving where GitLab CI reads its config needs the agent's own grant, like editing CI files (DOR-4508)"
---

### Fixed

- Changing where GitLab reads a project's CI setup from now needs to be given to that agent on its own, the same as editing CI files. Read and write no longer covers it.
