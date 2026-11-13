---
covers:
  - 'fix(server): Always allow narrows every whole-server rule shape, and the MCP server sheet reads them right (DOR-4240)'
---

### Fixed

- **Always allow** on an MCP tool now allows just that tool in more cases: when the server's name has two underscores in a row, or when Claude offers a rule ending in `*`. Every tool from the server is allowed only when you pick that. (DOR-4240)
- An MCP server's sheet now lists a rule ending in `*` as every tool, not one tool named `*`, and **Make it ask** can take it back. A server whose name has two underscores in a row no longer shows up on another server's sheet. (DOR-4240)
