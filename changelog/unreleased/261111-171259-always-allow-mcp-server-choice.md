---
covers:
  - 'fix(ask): Always allow on an MCP tool asks whether you mean that tool or every tool from its server (DOR-4101)'
---

### Fixed

- When an agent asks to use a tool from an MCP server, **Always allow…** now asks what you mean: **Just** that tool, which is picked for you, or **every tool from** that server, including ones it adds later. Before, it could allow every tool the server had without saying so. An answer that doesn't say which now allows just the one tool. (DOR-4101)
