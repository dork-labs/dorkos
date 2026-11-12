---
covers:
  - 'refactor(config): remove the retired global MCP key setting'
  - 'refactor(auth): retire global MCP key compatibility'
  - 'fix(config): refuse retired auth settings before opening'
  - 'refactor(config): retire the activeAccount alias'
  - 'refactor(config): drop retired config flag tolerances'
  - 'refactor(config): retire legacy sidebar conversion'
  - 'refactor(config): retire v0.60-v0.89 migrators (DOR-4188)'
  - 'refactor(config): retire v0.57-v0.59 migrators (DOR-4188)'
  - 'refactor(config): retire v0.44-v0.56 migrators (DOR-4188)'
  - 'fix(config): refuse upgrades from before 0.115 (DOR-4188)'
---

### Note for people upgrading

- Upgrade settings last used before 0.115 through version 0.115 first. DorkOS stops before changing older settings and explains the two steps (DOR-4188).
