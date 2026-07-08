### Added

- The external MCP server (`/mcp`) now advertises a DorkOS server icon and accurate `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` annotations on every one of its 48 tools, so MCP clients can distinguish safe lookups from destructive or network-reaching actions before calling them
- `get_agent`, `mesh_list`, `mesh_status`, `mesh_inspect`, `mesh_query_topology`, `tasks_list`, and `relay_get_metrics` return structured JSON output (`structuredContent`) alongside their existing text response
