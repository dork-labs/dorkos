---
covers:
  - 'fix(harness): a linked-in skill is a skill, and `__` alone is not a projection (DOR-1844)'
  - 'fix(server): the Codex palette and dorkos://skills show what Codex reads (DOR-1844)'
  - "fix(harness): a package's skill dir may not be a symlink out of the package (DOR-1844)"
---

### Fixed

- A Codex chat you start from DorkOS now offers the same skills the `codex` command does, including ones that came from a package you installed or a folder you linked in. Those skills always worked in your own terminal; they were just missing from the DorkOS slash menu and from the list your agent reads (DOR-1844)
