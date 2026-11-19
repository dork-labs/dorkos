---
covers:
  - "fix(connections): a GitLab commit started from another commit or project needs the agent's own grant, like a new branch (DOR-4507)"
---

### Fixed

- Making a GitLab commit that starts from another commit or another project now needs that action given to the agent on its own, the same as starting a new branch. Read and write, sharing GitLab with every agent, or allowing it in one chat no longer covers it. Inline review comments are unchanged.
