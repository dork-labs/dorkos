---
covers:
  - 'fix(mesh): bump @modelcontextprotocol/sdk to 1.31.0 and keep a hand-entered client marked as yours'
---

### Security

- An agent's sign-in to an MCP server is now kept for the sign-in service that issued it. If that server starts sending DorkOS to a different sign-in service, DorkOS no longer hands it the old login
