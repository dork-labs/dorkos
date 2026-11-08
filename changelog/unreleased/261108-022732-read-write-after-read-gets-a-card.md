---
covers:
  - 'fix(connectors): asking for read-write after read was allowed opens a new card (DOR-3930)'
---

### Fixed

- When you've let an agent read an app and it later asks to change things there too, you now get a new card for that. Before, the agent was told it had access while it could still only read. (DOR-3930)
