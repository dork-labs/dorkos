### Security

- Close a gap where any program on your computer could run the DorkOS tools that change things — creating agents, sending messages, installing packages — without any token. When you haven't turned on login, those tools and agent-to-agent calls now need a one-time token you paste into your MCP client. Find it in Settings → Tools → External MCP Server. (DOR-278)

### Changed

- External MCP and A2A clients now need your local token when login is off. Health checks and listing tools still work without one, and there is no grace period: paste the token into any client you already set up to keep using the tools that change things. You can copy it from Settings → Tools → External MCP Server, or read it from the `mcp-local-token` file in your DorkOS data folder. (DOR-278)
