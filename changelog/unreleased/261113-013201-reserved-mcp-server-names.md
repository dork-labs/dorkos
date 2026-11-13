---
covers:
  - "fix(server): no MCP server can take one of DorkOS's own names, in any case, on any runtime (DOR-3600)"
---

### Fixed

- An MCP server can no longer be named like one of DorkOS's own servers, such as `DorkOS` or `dorkos_connections`, in any mix of capitals. Add a server says so as soon as you leave the Name field: "DorkOS is one of DorkOS's own names. Pick another." Every agent runtime leaves out a server with one of those names, so nothing can stand in for DorkOS's own tools. (DOR-3600)
