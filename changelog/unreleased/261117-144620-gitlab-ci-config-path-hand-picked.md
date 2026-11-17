---
covers:
  - "fix(connections): moving where GitLab CI reads its config needs the agent's own grant, like editing CI files (DOR-4508)"
  - "fix(connections): GitLab inline review comments stay under Read and write; start_sha counts only where a commit takes it (DOR-4507, DOR-4508)"
---

### Fixed

- Changing where GitLab reads a project's CI setup from now needs that action given to the agent on its own, the same as editing CI files. Read and write, sharing GitLab with every agent, or allowing it in one chat no longer covers it.
