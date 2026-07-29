---
covers:
  - 'feat(connectors): server truth — live credential seam, agent tools, Nango Proxy→MCP (DOR-371, DOR-415)'
---

### Added

- Saving your Composio or Nango key now turns that connector on instantly — no restart. Delete the key and it switches off the same way (DOR-371)
- Your agent can now connect services when you ask. Say "connect my Gmail" and it replies with the sign-in link and a plain sentence about where your login lives; attaching the account to a session still asks you first (DOR-371)
- Accounts connected through your own Nango server now give your agent a tool that can call that service's API — your logins stay in your database the whole time (DOR-415)
- List remote MCP servers under `connectors.rawMcpServers` in your config to offer them as connectable services (DOR-371)
