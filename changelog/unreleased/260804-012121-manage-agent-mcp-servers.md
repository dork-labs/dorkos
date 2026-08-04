---
covers:
  - 'feat(mcp): managed MCP server schema + AgentMcpServerService (DOR-891 P1)'
  - 'feat(mcp): mcp.* capability domain + claude-code managed-server injection (DOR-891 P2)'
  - 'feat(mcp): client Transport methods + Agent Hub Toolkit UI for managed MCP servers (DOR-891 P3)'
  - "fix(mcp): reword capability copy off the banned term 'connection' (DOR-891)"
  - 'refactor(mcp): address adversarial review nits (DOR-891)'
---

### Added

- Manage an agent's MCP servers right inside DorkOS. Open an agent and go to its Toolkit tab to add a server (a local command or a remote URL), turn it on or off, test the connection, and see at a glance whether it's connected — no terminal and no config files to edit. Before a new server can run, DorkOS shows you the exact command it will start and asks you to approve it. Available for Claude Code agents now.
