### Security

- The DorkOS tools that change things on your machine — creating agents, sending messages, installing packages — and agent-to-agent calls now need a token when login is off. Before, any program on your computer could call them with no token at all. This closes that open door, the same way Jupyter protects its local server. One honest limit: while login is off, a program running on your computer can still ask DorkOS for the token, the same way the app does. Turning on login is what closes that last door. (DOR-278)

### Changed

- External MCP and A2A clients now need your local token when login is off. Health checks and listing tools still work without one, and there is no grace period: paste the token into any client you already set up to keep using the tools that change things. Click "Reveal token" in Settings → Tools → External MCP Server to copy it, or read it from the `mcp-local-token` file in your DorkOS data folder. (DOR-278)
