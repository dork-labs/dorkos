---
covers:
  - "fix(api): a person's MCP server checks, removal and undoing a standing yes are served by the capability mount; four network-reachable routes stay by hand (DOR-4978)"
  - 'fix(api): review round 1 on the MCP server doors (DOR-4978)'
---

### Changed

- For scripts that use the DorkOS API: checking typed arguments for an MCP server every agent gets, removing one, and its sheet's tool check and Undo are now described in the API document, under new operation names (`mcp.remove_global_server` and the rest). Undoing one agent's standing yes takes the agent and the rule in the query string (`DELETE /api/mcp-servers/{name}/allows?agentId=…&rule=…`), not a request body. A call from an agent, or one that sends an API key or any `Authorization` header, is refused with `person_only`; removing a server was refused with `operator_only` before. When an agent's settings file can't be changed, the answer no longer names the agent.
