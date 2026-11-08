---
covers:
  - 'fix(server): a bracket range ending in [ may hold anything (DOR-3300)'
---

### Fixed

- An agent can no longer slip past the setup-file guard with an odd wildcard like `settings[,-[]json`.
