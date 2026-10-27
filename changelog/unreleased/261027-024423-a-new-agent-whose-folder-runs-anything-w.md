---
covers:
  - 'fix(server): a new agent whose folder runs anything waits for a person (DOR-3068)'
---

### Fixed

- A new agent whose folder already runs something, like hooks, MCP servers, its own account or another runtime, waits for your yes before any of it runs. A new agent whose folder runs nothing starts right away.
