---
covers:
  - 'fix(opencode): a turn nobody is watching can read the packages you installed for all projects'
---

### Fixed

- An agent on OpenCode can now read the skills of a package you installed for all your projects, even in a scheduled run nobody is watching. Before, it hit a question about leaving the project folder that nobody could answer, so the skill would not load. It can read the package's own folder only, and can never change it (DOR-4386).
